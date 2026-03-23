const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { postsLimiter } = require('../middleware/limiters');

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

  // Score formula
  let score = (likes * 2) + (interests * 3) + (comments * 1.5);

  // Recent boost: +10 for <24h, +5 for <48h
  if (hoursAge < 24) score += 10;
  else if (hoursAge < 48) score += 5;

  // Time decay: reduce as post ages
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
        looking_for: looking_for || ''
      })
      .select(`
        id, user_id, category, problem, solution, revenue_model, looking_for, likes_count, comments_count, created_at,
        user:users!ideas_user_id_fkey!inner(id, name, profile_image, role)
      `)
      .single();

    if (error) throw error;

    await supabase.rpc('increment_field', { table_name: 'users', field_name: 'ideas_count', row_id: user.id });

    return res.json({ idea });
  } catch (err) {
    console.error('Create idea error:', err);
    return res.status(500).json({ error: 'Failed to create idea' });
  }
});

// ════════════════════════════════════════════════════════════
// GET /ideas/trending — Top 5 with time-decay score
// ════════════════════════════════════════════════════════════
router.get('/trending', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const user = await getCurrentUser(supabase, req.supabaseUser);

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Fetch recent ideas with interest counts
    const { data: ideas, error } = await supabase
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

    // Get interest counts for these ideas
    const ideaIds = (ideas || []).map(i => i.id);
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

    // Calculate scores and sort
    const scored = (ideas || []).map(idea => ({
      ...idea,
      interests_count: interestCounts[idea.id] || 0,
      trending_score: calculateTrendingScore({ ...idea, interests_count: interestCounts[idea.id] || 0 }),
    }));

    scored.sort((a, b) => b.trending_score - a.trending_score);
    const top5 = scored.slice(0, 5);

    // Enrich with user-specific data
    const enriched = await enrichIdeas(supabase, top5, user?.id);

    return res.json({ ideas: enriched });
  } catch (err) {
    console.error('Trending error:', err);
    return res.status(500).json({ error: 'Failed to get trending ideas' });
  }
});

// ════════════════════════════════════════════════════════════
// GET /ideas/feed — Hybrid ranking: 40% trending, 40% latest, 20% random
// ════════════════════════════════════════════════════════════
router.get('/feed', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const user = await getCurrentUser(supabase, req.supabaseUser);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Pool 1: Trending (40%) — recent ideas sorted by engagement
    const trendingLimit = Math.ceil(limit * 0.4);
    const { data: trendingPool } = await supabase
      .from('ideas')
      .select(`
        id, user_id, category, problem, solution, revenue_model, looking_for, likes_count, comments_count, created_at,
        user:users!ideas_user_id_fkey!inner(id, name, profile_image, role)
      `)
      .eq('user.is_banned', false)
      .eq('is_deleted', false)
      .gte('created_at', sevenDaysAgo)
      .order('likes_count', { ascending: false })
      .limit(trendingLimit * page); // Fetch enough for pagination

    // Pool 2: Latest (40%)
    const latestLimit = Math.ceil(limit * 0.4);
    const { data: latestPool } = await supabase
      .from('ideas')
      .select(`
        id, user_id, category, problem, solution, revenue_model, looking_for, likes_count, comments_count, created_at,
        user:users!ideas_user_id_fkey!inner(id, name, profile_image, role)
      `)
      .eq('user.is_banned', false)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(latestLimit * page);

    // Pool 3: Random low-engagement (20%)
    const randomLimit = Math.ceil(limit * 0.2);
    const { data: randomPool } = await supabase
      .from('ideas')
      .select(`
        id, user_id, category, problem, solution, revenue_model, looking_for, likes_count, comments_count, created_at,
        user:users!ideas_user_id_fkey!inner(id, name, profile_image, role)
      `)
      .eq('user.is_banned', false)
      .eq('is_deleted', false)
      .lt('likes_count', 3)
      .limit(randomLimit * page * 3); // Over-fetch to allow randomness

    // Deduplicate and merge
    const seenIds = new Set();
    const merged = [];

    // Take trending slice for this page
    const trendingSlice = (trendingPool || []).slice((page - 1) * trendingLimit, page * trendingLimit);
    for (const idea of trendingSlice) {
      if (!seenIds.has(idea.id)) { seenIds.add(idea.id); merged.push(idea); }
    }

    // Take latest slice
    const latestSlice = (latestPool || []).slice((page - 1) * latestLimit, page * latestLimit);
    for (const idea of latestSlice) {
      if (!seenIds.has(idea.id)) { seenIds.add(idea.id); merged.push(idea); }
    }

    // Take random slice (shuffle first)
    const shuffled = (randomPool || []).sort(() => Math.random() - 0.5);
    let randomAdded = 0;
    for (const idea of shuffled) {
      if (randomAdded >= randomLimit) break;
      if (!seenIds.has(idea.id)) { seenIds.add(idea.id); merged.push(idea); randomAdded++; }
    }

    // Interleave: don't serve in pure blocks, mix them
    const final_feed = merged.sort(() => Math.random() - 0.3);

    // Enrich with user-specific data
    const enriched = await enrichIdeas(supabase, final_feed, user?.id);

    return res.json({ ideas: enriched, page, limit });
  } catch (err) {
    console.error('Get feed error:', err);
    return res.status(500).json({ error: 'Failed to get feed' });
  }
});

// ════════════════════════════════════════════════════════════
// GET /ideas/discover — Weekly sections
// ════════════════════════════════════════════════════════════
router.get('/discover', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const user = await getCurrentUser(supabase, req.supabaseUser);
    const category = req.query.category || '';

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // "New this week" — created in last 7 days, newest first
    let newQuery = supabase
      .from('ideas')
      .select(`
        id, user_id, category, problem, solution, revenue_model, looking_for, likes_count, comments_count, created_at,
        user:users!ideas_user_id_fkey!inner(id, name, profile_image, role)
      `)
      .eq('user.is_banned', false)
      .eq('is_deleted', false)
      .gte('created_at', sevenDaysAgo)
      .order('created_at', { ascending: false })
      .limit(10);
    
    if (category) newQuery = newQuery.ilike('category', category);
    const { data: newThisWeek } = await newQuery;

    // "Rising" — this week, has engagement, high score
    let risingQuery = supabase
      .from('ideas')
      .select(`
        id, user_id, category, problem, solution, revenue_model, looking_for, likes_count, comments_count, created_at,
        user:users!ideas_user_id_fkey!inner(id, name, profile_image, role)
      `)
      .eq('user.is_banned', false)
      .eq('is_deleted', false)
      .gte('created_at', sevenDaysAgo)
      .gt('likes_count', 0)
      .order('likes_count', { ascending: false })
      .limit(10);
    
    if (category) risingQuery = risingQuery.ilike('category', category);
    const { data: rising } = await risingQuery;

    // "Undiscovered" — 0 engagement, random
    let undiscoveredQuery = supabase
      .from('ideas')
      .select(`
        id, user_id, category, problem, solution, revenue_model, looking_for, likes_count, comments_count, created_at,
        user:users!ideas_user_id_fkey!inner(id, name, profile_image, role)
      `)
      .eq('user.is_banned', false)
      .eq('is_deleted', false)
      .eq('likes_count', 0)
      .eq('comments_count', 0)
      .limit(20);
    
    if (category) undiscoveredQuery = undiscoveredQuery.ilike('category', category);
    const { data: undiscoveredRaw } = await undiscoveredQuery;

    // Shuffle undiscovered for freshness
    const undiscovered = (undiscoveredRaw || []).sort(() => Math.random() - 0.5).slice(0, 10);

    // Enrich all sections
    const [enrichedNew, enrichedRising, enrichedUndiscovered] = await Promise.all([
      enrichIdeas(supabase, newThisWeek || [], user?.id),
      enrichIdeas(supabase, rising || [], user?.id),
      enrichIdeas(supabase, undiscovered, user?.id),
    ]);

    return res.json({
      new_this_week: enrichedNew,
      rising: enrichedRising,
      undiscovered: enrichedUndiscovered,
    });
  } catch (err) {
    console.error('Discover error:', err);
    return res.status(500).json({ error: 'Failed to get discover data' });
  }
});

// ════════════════════════════════════════════════════════════
// GET /ideas/:id — Single idea with interest_status
// ════════════════════════════════════════════════════════════
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const user = await getCurrentUser(supabase, req.supabaseUser);
    const { id } = req.params;

    const { data: idea, error } = await supabase
      .from('ideas')
      .select(`
        id, user_id, category, problem, solution, revenue_model, looking_for, likes_count, comments_count, created_at,
        user:users!ideas_user_id_fkey!inner(id, name, profile_image, role)
      `)
      .eq('user.is_banned', false)
      .eq('id', id)
      .single();

    if (error || !idea) return res.status(404).json({ error: 'Idea not found' });

    // Enrich with user-specific data (is_liked + interest_status)
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
    console.error('Get idea error:', err);
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
      .eq('id', id)
      .eq('user_id', user.id)
      .select(`
        *,
        user:users!ideas_user_id_fkey!inner(id, name, profile_image, role)
      `)
      .single();

    if (error) throw error;
    return res.json({ idea });
  } catch (err) {
    console.error('Edit idea error:', err);
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

    let query = supabase
      .from('ideas')
      .update({ is_deleted: true })
      .eq('id', id);

    if (!user.is_admin) {
      query = query.eq('user_id', user.id);
    }

    const { error } = await query;
    if (error) throw error;

    return res.json({ success: true });
  } catch (err) {
    console.error('Delete idea error:', err);
    return res.status(500).json({ error: 'Failed to delete idea' });
  }
});

module.exports = router;
