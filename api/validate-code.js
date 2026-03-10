export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code is required' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

  try {
    const lookupRes = await fetch(
      `${SUPABASE_URL}/rest/v1/access_codes?code=eq.${encodeURIComponent(code.trim().toUpperCase())}&select=*`,
      {
        headers: {
          apikey: SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        },
      }
    );

    const rows = await lookupRes.json();

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'Invalid code. Please check and try again.' });
    }

    const record = rows[0];

    if (!record.is_active) {
      return res.status(403).json({ error: 'This code has been deactivated.' });
    }

    if (record.expires_at && new Date(record.expires_at) < new Date()) {
      return res.status(403).json({ error: 'This code has expired. Please purchase a new plan.' });
    }

    const now = new Date().toISOString();
    const isFirstUse = !record.activated_at;

    if (isFirstUse) {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 90);

      await fetch(
        `${SUPABASE_URL}/rest/v1/access_codes?code=eq.${encodeURIComponent(code.trim().toUpperCase())}`,
        {
          method: 'PATCH',
          headers: {
            apikey: SUPABASE_SECRET_KEY,
            Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            activated_at: now,
            expires_at: expiresAt.toISOString(),
          }),
        }
      );

      // Return record with activation timestamps filled in
      record.activated_at = now;
      record.expires_at = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    }

    // Return full record as `row` — this is what App.jsx reads
    return res.status(200).json({ row: record });

  } catch (err) {
    console.error('validate-code error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
}
