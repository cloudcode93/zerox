'use strict';

const { createClient } = require('@supabase/supabase-js');

/**
 * Supabase Service-Role Client (singleton)
 * 
 * Used for all backend operations. Service role bypasses RLS,
 * so this must only be used server-side, never exposed to clients.
 */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

module.exports = supabase;
