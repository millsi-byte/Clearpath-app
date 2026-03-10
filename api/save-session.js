export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { code, sessionData, messages } = req.body;
  if (!code) return res.status(400).json({ error: 'Code is required' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

  try {
    const updateRes = await fetch(
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
          ...(sessionData !== undefined && { session_data: sessionData }),
          ...(messages !== undefined && { messages }),
        }),
      }
    );

    if (!updateRes.ok) {
      const err = await updateRes.text();
      throw new Error(err);
    }

    return res.status(200).json({ saved: true });
  } catch (err) {
    console.error('save-session error:', err);
    return res.status(500).json({ error: 'Failed to save session.' });
  }
}
