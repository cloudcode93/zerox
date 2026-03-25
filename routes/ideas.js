'use strict';

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { postsLimiter } = require('../middleware/limiters');
const logger = require('../config/logger');
const cache = require('../lib/cache');

// ════════════════════════════════════════════════════════════
// HELPER: Get current user from supabaseUser
// ════════════════════════════════════════════════════════════
async function getCurrentUser(supabase, supabaseUser) {
  const { data: user } = await supabase
    .from('users')
    .select('id, role, is_admin')
    .eq('supabase_uid', supabaseUser.id)
    .single();
  return user;
}

// ════════════════════════════════════════════════════════════
// HELPER: Enrich ideas with is_liked & interest_status
// ════════════════════════════════════════════════════════════
async function enrichIdeas(supabase, ideas, userId) {
  if (!userId || ideas.length === 0) return ideas;

  const ideaIds = ideas.map(i => i.id);

  const [{ data: userLikes }, { data: userInterests }] = await Promise.all([
    supabase.from('likes').select('idea_id').eq('user_id', userId).in('idea_id', ideaIds),
    supabase.from('interests').select('idea_id, status').eq('investor_id', userId).in('idea_id', ideaIds),
  ]);

  const likedSet = new Set((userLikes || []).map(l => l.idea_id));
  const interestMap = {};
  (userInterests || []).forEach(i => { interestMap[i.idea_id] = i.status; });

  return ideas.map(idea => ({
    ...idea,
    is_liked: likedSet.has(idea.id),
    interest_status: interestMap[idea.id] || null,
  }));
}

// ════════════════════════════════════════════════════════════
// HELPER: Calculate trending score
// ════════════════════════════════════════════════════════════
function calculateTrendingScore(idea) {
  const now = Date.now();
  const createdAt = new Date(idea.created_at).getTime();
  const hoursAge = (now - createdAt) / (1000 * 60 * 60);

  const likes = idea.likes_count || 0;
  const comments = idea.comments_count || 0;
  const interests = idea.interests_count || 0;

  let score = (likes * 2) + (interests * 3) + (comments * 1.5);

  if (hoursAge < 24) score += 10;
  else if (hoursAge < 48) score += 5;

  score -= hoursAge / 6;

  return Math.max(score, 0);
}

// ════════════════════════════════════════════════════════════
// POST /ideas/create
// ════════════════════════════════════════════════════════════
router.post('/create', authMiddleware, postsLimiter, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const user = await getCurrentUser(supabase, req.supabaseUser);

    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'investor') return res.status(403).json({ error: 'Investors cannot create ideas' });

    const { category, problem, solution, revenue_model, looking_for } = req.body;

    const { data: idea, error } = await supabase
      .from('ideas')
      .insert({
        user_id: user.id,
        category: category || 'General',
        problem,
        solution,
        revenue_model: revenue_model || '',
        looking_for: looking_for || '',
      })
      .select(`
        id, user_id, category, problem, solution, revenue_model, looking_for, likes_count, comments_count, created_at,
        user:users!ideas_user_id_fkey!inner(id, name, profile_image, role)
      `)
      .single();

    if (error) throw error;

    await supabase.rpc('increment_field', { table_name: 'users', field_name: 'ideas_count', row_id: user.id });

    // Invalidate feed/discover caches
    await cache.delPattern('feed:*');
    await cache.delPattern('discover:*');
    await cache.del('trending');

    return res.json({ idea });
  } catch (err) {
    logger.error('Create idea error:', err);
    return res.status(500).json({ error: 'Failed to create idea' });
  }
});

// ════════════════════════════════════════════════════════════
// GET /ideas/trending (cached 120s)
// ════════════════════════════════════════════════════════════
router.get('/trending', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const user = await getCurrentUser(supabase, req.supabaseUser);

    // Check cache (non-personalized part)
    const cacheKey = 'trending';
    let ideas = await cache.get(cacheKey);

    if (!ideas) {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

      const { data: rawIdeas, error } = await supabase
        .from('ideas')
        .select(`
          id, user_id, category, problem, solution, revenue_model, looking_for, likes_count, comments_count, created_at,
          user:users!ideas_user_id_fkey!inner(id, name, profile_image, role)
        `)
        .eq('user.is_banned', false)
        .eq('is_deleted', false)
        .gte('created_at', sevenDaysAgo)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;

      const ideaIds = (rawIdeas || []).map(i => i.id);
      let interestCounts = {};
      if (ideaIds.length > 0) {
        const { data: interests } = await supabase
          .from('interests')
          .select('idea_id')
          .in('idea_id', ideaIds);
        (interests || []).forEach(i => {
          interestCounts[i.idea_id] = (interestCounts[i.idea_id] || 0) + 1;
        });
      }

      const scored = (rawIdeas || []).map(idea => ({
        ...idea,
        interests_count: interestCounts[idea.id] || 0,
        trending_score: calculateTrendingScore({ ...idea, interests_count: interestCounts[idea.id] || 0 }),
      }));

      scored.sort((a, b) => b.trending_score - a.trending_score);
      ideas = scored.slice(0, 5);

      // Cache the non-personalized trending list
      await cache.set(cacheKey, ideas, 120);
    }

    // Enrich with user-specific data (always fresh)
    const enriched = await enrichIdeas(supabase, ideas, user?.id);
    return res.json({ ideas: enriched });
  } catch (err) {
    logger.error('Trending error:', err);
    return res.status(500).json({ error: 'Failed to get trending ideas' });
  }
});

// ════════════════════════════════════════════════════════════
// GET /ideas/feed (cached 60s per page)
// ════════════════════════════════════════════════════════════
router.get('/feed', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const user = await getCurrentUser(supabase, req.supabaseUser);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    // Check cache
    const cacheKey = `feed:p${page}:l${limit}`;
    let feedData = await cache.get(cacheKey);

    if (!feedData) {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

      const trendingLimit = Math.ceil(limit * 0.4);
      const latestLimit = Math.ceil(limit * 0.4);
      const randomLimit = Math.ceil(limit * 0.2);

      const [{ data: trendingPool }, { data: latestPool }, { data: randomPool }] = await Promise.all([
        supabase.from('ideas')
          .select('id, user_id, category, problem, solution, revenue_model, looking_for, likes_count, comments_count, created_at, user:users!ideas_user_id_fkey!inner(id, name, profile_image, role)')
          .eq('user.is_banned', false).eq('is_deleted', false).gte('created_at', sevenDaysAgo)
          .order('likes_count', { ascending: false }).limit(trendingLimit * page),
        supabase.from('ideas')
          .select('id, user_id, category, problem, solution, revenue_model, looking_for, likes_count, comments_count, created_at, user:users!ideas_user_id_fkey!inner(id, name, profile_image, role)')
          .eq('user.is_banned', false).eq('is_deleted', false)
          .order('created_at', { ascending: false }).limit(latestLimit * page),
        supabase.from('ideas')
          .select('id, user_id, category, problem, solution, revenue_model, looking_for, likes_count, comments_count, created_at, user:users!ideas_user_id_fkey!inner(id, name, profile_image, role)')
          .eq('user.is_banned', false).eq('is_deleted', false).lt('likes_count', 3)
          .limit(randomLimit * page * 3),
      ]);

      const seenIds = new Set();
      const merged = [];

      const trendingSlice = (trendingPool || []).slice((page - 1) * trendingLimit, page * trendingLimit);
      for (const idea of trendingSlice) {
        if (!seenIds.has(idea.id)) { seenIds.add(idea.id); merged.push(idea); }
      }

      const latestSlice = (latestPool || []).slice((page - 1) * latestLimit, page * latestLimit);
      for (const idea of latestSlice) {
        if (!seenIds.has(idea.id)) { seenIds.add(idea.id); merged.push(idea); }
      }

      const shuffled = (randomPool || []).sort(() => Math.random() - 0.5);
      let randomAdded = 0;
      for (const idea of shuffled) {
        if (randomAdded >= randomLimit) break;
        if (!seenIds.has(idea.id)) { seenIds.add(idea.id); merged.push(idea); randomAdded++; }
      }

      feedData = merged.sort(() => Math.random() - 0.3);
      await cache.set(cacheKey, feedData, 60);
    }

    const enriched = await enrichIdeas(supabase, feedData, user?.id);
    return res.json({ ideas: enriched, page, limit });
  } catch (err) {
    logger.error('Get feed error:', err);
    return res.status(500).json({ error: 'Failed to get feed' });
  }
});

// ════════════════════════════════════════════════════════════
// GET /ideas/discover (cached 120s)
// ════════════════════════════════════════════════════════════
router.get('/discover', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const user = await getCurrentUser(supabase, req.supabaseUser);
    const category = req.query.category || '';

    const cacheKey = `discover:${category || 'all'}`;
    let discoverData = await cache.get(cacheKey);

    if (!discoverData) {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

      let newQuery = supabase.from('ideas')
        .select('id, user_id, category, problem, solution, revenue_model, looking_for, likes_count, comments_count, created_at, user:users!ideas_user_id_fkey!inner(id, name, profile_image, role)')
        .eq('user.is_banned', false).eq('is_deleted', false).gte('created_at', sevenDaysAgo)
        .order('created_at', { ascending: false }).limit(10);
      if (category) newQuery = newQuery.ilike('category', category);
      const { data: newThisWeek } = await newQuery;

      let risingQuery = supabase.from('ideas')
        .select('id, user_id, category, problem, solution, revenue_model, looking_for, likes_count, comments_count, created_at, user:users!ideas_user_id_fkey!inner(id, name, profile_image, role)')
        .eq('user.is_banned', false).eq('is_deleted', false).gte('created_at', sevenDaysAgo)
        .gt('likes_count', 0).order('likes_count', { ascending: false }).limit(10);
      if (category) risingQuery = risingQuery.ilike('category', category);
      const { data: rising } = await risingQuery;

      let undiscoveredQuery = supabase.from('ideas')
        .select('id, user_id, category, problem, solution, revenue_model, looking_for, likes_count, comments_count, created_at, user:users!ideas_user_id_fkey!inner(id, name, profile_image, role)')
        .eq('user.is_banned', false).eq('is_deleted', false).eq('likes_count', 0).eq('comments_count', 0).limit(20);
      if (category) undiscoveredQuery = undiscoveredQuery.ilike('category', category);
      const { data: undiscoveredRaw } = await undiscoveredQuery;

      const undiscovered = (undiscoveredRaw || []).sort(() => Math.random() - 0.5).slice(0, 10);

      discoverData = {
        new_this_week: newThisWeek || [],
        rising: rising || [],
        undiscovered,
      };

      await cache.set(cacheKey, discoverData, 120);
    }

    const [enrichedNew, enrichedRising, enrichedUndiscovered] = await Promise.all([
      enrichIdeas(supabase, discoverData.new_this_week, user?.id),
      enrichIdeas(supabase, discoverData.rising, user?.id),
      enrichIdeas(supabase, discoverData.undiscovered, user?.id),
    ]);

    return res.json({
      new_this_week: enrichedNew,
      rising: enrichedRising,
      undiscovered: enrichedUndiscovered,
    });
  } catch (err) {
    logger.error('Discover error:', err);
    return res.status(500).json({ error: 'Failed to get discover data' });
  }
});

// ════════════════════════════════════════════════════════════
// GET /ideas/:id
// ════════════════════════════════════════════════════════════
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const user = await getCurrentUser(supabase, req.supabaseUser);
    const { id } = req.params;

    const { data: idea, error } = await supabase
      .from('ideas')
      .select('id, user_id, category, problem, solution, revenue_model, looking_for, likes_count, comments_count, created_at, user:users!ideas_user_id_fkey!inner(id, name, profile_image, role)')
      .eq('user.is_banned', false).eq('id', id).single();

    if (error || !idea) return res.status(404).json({ error: 'Idea not found' });

    let enrichedIdea = { ...idea, is_liked: false, interest_status: null };

    if (user) {
      const [{ data: likeData }, { data: interestData }] = await Promise.all([
        supabase.from('likes').select('id').eq('user_id', user.id).eq('idea_id', id).maybeSingle(),
        supabase.from('interests').select('status').eq('investor_id', user.id).eq('idea_id', id).maybeSingle(),
      ]);
      enrichedIdea.is_liked = !!likeData;
      enrichedIdea.interest_status = interestData?.status || null;
    }

    return res.json({ idea: enrichedIdea });
  } catch (err) {
    logger.error('Get idea error:', err);
    return res.status(500).json({ error: 'Failed to get idea' });
  }
});

// ════════════════════════════════════════════════════════════
// PUT /ideas/edit
// ════════════════════════════════════════════════════════════
router.put('/edit', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const user = await getCurrentUser(supabase, req.supabaseUser);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { id, category, problem, solution, revenue_model, looking_for } = req.body;

    const updateData = { updated_at: new Date().toISOString() };
    if (category !== undefined) updateData.category = category;
    if (problem !== undefined) updateData.problem = problem;
    if (solution !== undefined) updateData.solution = solution;
    if (revenue_model !== undefined) updateData.revenue_model = revenue_model;
    if (looking_for !== undefined) updateData.looking_for = looking_for;

    const { data: idea, error } = await supabase
      .from('ideas')
      .update(updateData)
      .eq('id', id).eq('user_id', user.id)
      .select('*, user:users!ideas_user_id_fkey!inner(id, name, profile_image, role)')
      .single();

    if (error) throw error;
    return res.json({ idea });
  } catch (err) {
    logger.error('Edit idea error:', err);
    return res.status(500).json({ error: 'Failed to edit idea' });
  }
});

// ════════════════════════════════════════════════════════════
// DELETE /ideas/delete
// ════════════════════════════════════════════════════════════
router.delete('/delete', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const user = await getCurrentUser(supabase, req.supabaseUser);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { id } = req.body;
    let query = supabase.from('ideas').update({ is_deleted: true }).eq('id', id);
    if (!user.is_admin) query = query.eq('user_id', user.id);

    const { error } = await query;
    if (error) throw error;

    // Invalidate caches
    await cache.delPattern('feed:*');
    await cache.delPattern('discover:*');
    await cache.del('trending');

    return res.json({ success: true });
  } catch (err) {
    logger.error('Delete idea error:', err);
    return res.status(500).json({ error: 'Failed to delete idea' });
  }
});

module.exports = router;
