const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { postsLimiter } = require('../middleware/limiters');

// ════════════════════════════════════════════════════════════
// HELPER: Get current user from supabaseUser (cached)
// ════════════════════════════════════════════════════════════
async function getCurrentUser(supabase, supabaseUser, cache) {
  if (cache) {
    const cached = await cache.get(`current_user:${supabaseUser.id}`);
    if (cached) return cached;
  }

  const { data: user } = await supabase
    .from('users')
    .select('id, role, is_admin')
    .eq('supabase_uid', supabaseUser.id)
    .single();

  if (user && cache) {
    await cache.set(`current_user:${supabaseUser.id}`, user, 120);
  }
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

// Shared select fields (avoid select('*'))
const IDEA_FIELDS = `id, user_id, category, problem, solution, revenue_model, looking_for, likes_count, comments_count, created_at,
  user:users!ideas_user_id_fkey!inner(id, name, profile_image, role)`;

// ════════════════════════════════════════════════════════════
// POST /ideas/create
// ════════════════════════════════════════════════════════════
router.post('/create', authMiddleware, postsLimiter, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const cache = req.app.get('cache');
    const user = await getCurrentUser(supabase, req.supabaseUser, cache);

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
      .select(IDEA_FIELDS)
      .single();

    if (error) throw error;

    await supabase.rpc('increment_field', { table_name: 'users', field_name: 'ideas_count', row_id: user.id });

    // Invalidate feed/trending caches
    if (cache) {
      await cache.invalidatePattern('feed:*');
      await cache.invalidatePattern('trending:*');
      await cache.invalidatePattern('discover:*');
    }

    return res.json({ idea });
  } catch (err) {
    console.error('Create idea error:', err);
    return res.status(500).json({ error: 'Failed to create idea' });
  }
});

// ════════════════════════════════════════════════════════════
// GET /ideas/trending — Cached (60s)
// ════════════════════════════════════════════════════════════
router.get('/trending', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const cache = req.app.get('cache');
    const user = await getCurrentUser(supabase, req.supabaseUser, cache);

    // Try cache for the base trending data (shared across all users)
    let scored = cache ? await cache.get('trending:base') : null;

    if (!scored) {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const { data: ideas, error } = await supabase
        .from('ideas')
        .select(IDEA_FIELDS)
        .eq('user.is_banned', false)
        .eq('is_deleted', false)
        .gte('created_at', sevenDaysAgo)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;

      const ideaIds = (ideas || []).map(i => i.id);
      let interestCounts = {};
      if (ideaIds.length > 0) {
        const { data: interests } = await supabase
          .from('interests').select('idea_id').in('idea_id', ideaIds);
        (interests || []).forEach(i => {
          interestCounts[i.idea_id] = (interestCounts[i.idea_id] || 0) + 1;
        });
      }

      scored = (ideas || []).map(idea => ({
        ...idea,
        interests_count: interestCounts[idea.id] || 0,
        trending_score: calculateTrendingScore({ ...idea, interests_count: interestCounts[idea.id] || 0 }),
      }));

      scored.sort((a, b) => b.trending_score - a.trending_score);
      scored = scored.slice(0, 5);

      if (cache) await cache.set('trending:base', scored, 60);
    }

    // Enrich with user-specific data (not cached — per-user)
    const enriched = await enrichIdeas(supabase, scored, user?.id);
    return res.json({ ideas: enriched });
  } catch (err) {
    console.error('Trending error:', err);
    return res.status(500).json({ error: 'Failed to get trending ideas' });
  }
});

// ════════════════════════════════════════════════════════════
// GET /ideas/feed — Cached per page (30s)
// ════════════════════════════════════════════════════════════
router.get('/feed', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const cache = req.app.get('cache');
    const user = await getCurrentUser(supabase, req.supabaseUser, cache);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    // Try cache for base feed data
    let merged = cache ? await cache.get(`feed:page:${page}:${limit}`) : null;

    if (!merged) {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const trendingLimit = Math.ceil(limit * 0.4);
      const latestLimit = Math.ceil(limit * 0.4);
      const randomLimit = Math.ceil(limit * 0.2);

      // Parallel DB queries
      const [{ data: trendingPool }, { data: latestPool }, { data: randomPool }] = await Promise.all([
        supabase
          .from('ideas').select(IDEA_FIELDS)
          .eq('user.is_banned', false).eq('is_deleted', false)
          .gte('created_at', sevenDaysAgo)
          .order('likes_count', { ascending: false })
          .limit(trendingLimit * page),
        supabase
          .from('ideas').select(IDEA_FIELDS)
          .eq('user.is_banned', false).eq('is_deleted', false)
          .order('created_at', { ascending: false })
          .limit(latestLimit * page),
        supabase
          .from('ideas').select(IDEA_FIELDS)
          .eq('user.is_banned', false).eq('is_deleted', false)
          .lt('likes_count', 3)
          .limit(randomLimit * page * 3),
      ]);

      // Deduplicate and merge
      const seenIds = new Set();
      merged = [];

      for (const idea of (trendingPool || []).slice((page - 1) * trendingLimit, page * trendingLimit)) {
        if (!seenIds.has(idea.id)) { seenIds.add(idea.id); merged.push(idea); }
      }
      for (const idea of (latestPool || []).slice((page - 1) * latestLimit, page * latestLimit)) {
        if (!seenIds.has(idea.id)) { seenIds.add(idea.id); merged.push(idea); }
      }
      const shuffled = (randomPool || []).sort(() => Math.random() - 0.5);
      let randomAdded = 0;
      for (const idea of shuffled) {
        if (randomAdded >= randomLimit) break;
        if (!seenIds.has(idea.id)) { seenIds.add(idea.id); merged.push(idea); randomAdded++; }
      }

      merged = merged.sort(() => Math.random() - 0.3);
      if (cache) await cache.set(`feed:page:${page}:${limit}`, merged, 30);
    }

    const enriched = await enrichIdeas(supabase, merged, user?.id);
    return res.json({ ideas: enriched, page, limit });
  } catch (err) {
    console.error('Get feed error:', err);
    return res.status(500).json({ error: 'Failed to get feed' });
  }
});

// ════════════════════════════════════════════════════════════
// GET /ideas/discover — Cached (60s)
// ════════════════════════════════════════════════════════════
router.get('/discover', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const cache = req.app.get('cache');
    const user = await getCurrentUser(supabase, req.supabaseUser, cache);
    const category = req.query.category || '';

    const cacheKey = `discover:${category || 'all'}`;
    let sections = cache ? await cache.get(cacheKey) : null;

    if (!sections) {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      let newQuery = supabase.from('ideas').select(IDEA_FIELDS)
        .eq('user.is_banned', false).eq('is_deleted', false)
        .gte('created_at', sevenDaysAgo).order('created_at', { ascending: false }).limit(10);
      if (category) newQuery = newQuery.ilike('category', category);

      let risingQuery = supabase.from('ideas').select(IDEA_FIELDS)
        .eq('user.is_banned', false).eq('is_deleted', false)
        .gte('created_at', sevenDaysAgo).gt('likes_count', 0)
        .order('likes_count', { ascending: false }).limit(10);
      if (category) risingQuery = risingQuery.ilike('category', category);

      let undiscoveredQuery = supabase.from('ideas').select(IDEA_FIELDS)
        .eq('user.is_banned', false).eq('is_deleted', false)
        .eq('likes_count', 0).eq('comments_count', 0).limit(20);
      if (category) undiscoveredQuery = undiscoveredQuery.ilike('category', category);

      const [{ data: newThisWeek }, { data: rising }, { data: undiscoveredRaw }] = await Promise.all([
        newQuery, risingQuery, undiscoveredQuery,
      ]);

      const undiscovered = (undiscoveredRaw || []).sort(() => Math.random() - 0.5).slice(0, 10);
      sections = { newThisWeek: newThisWeek || [], rising: rising || [], undiscovered };

      if (cache) await cache.set(cacheKey, sections, 60);
    }

    // Enrich per user
    const [enrichedNew, enrichedRising, enrichedUndiscovered] = await Promise.all([
      enrichIdeas(supabase, sections.newThisWeek, user?.id),
      enrichIdeas(supabase, sections.rising, user?.id),
      enrichIdeas(supabase, sections.undiscovered, user?.id),
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
// GET /ideas/:id — Single idea
// ════════════════════════════════════════════════════════════
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    const cache = req.app.get('cache');
    const user = await getCurrentUser(supabase, req.supabaseUser, cache);
    const { id } = req.params;

    const { data: idea, error } = await supabase
      .from('ideas')
      .select(IDEA_FIELDS)
      .eq('user.is_banned', false)
      .eq('id', id)
      .single();

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
    const cache = req.app.get('cache');
    const user = await getCurrentUser(supabase, req.supabaseUser, cache);

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
      .select(IDEA_FIELDS)
      .single();

    if (error) throw error;

    // Invalidate caches
    if (cache) {
      await cache.invalidatePattern('feed:*');
      await cache.invalidatePattern('trending:*');
    }

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
    const cache = req.app.get('cache');
    const user = await getCurrentUser(supabase, req.supabaseUser, cache);

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

    // Invalidate caches
    if (cache) {
      await cache.invalidatePattern('feed:*');
      await cache.invalidatePattern('trending:*');
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Delete idea error:', err);
    return res.status(500).json({ error: 'Failed to delete idea' });
  }
});

module.exports = router;
