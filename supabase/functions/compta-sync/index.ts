// Export comptable en lecture seule pour « Comptabilité Nowis » (serveur local).
// Authentification par clé propre (empreinte SHA-256 dans compta_sync_clients), aucune écriture.
// Déploiement : verify_jwt = false (la fonction fait sa propre vérification de clé).
const secrets = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY') || secrets.default;
const url = Deno.env.get('SUPABASE_URL');
if (!url || typeof key !== 'string' || !key) throw new Error('Configuration serveur manquante');

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (value: unknown, status = 200) => Response.json(value, { status, headers });

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== 'GET') return reply({ error: 'METHOD' }, 405);
  const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{40,200})$/)?.[1];
  if (!token) return reply({ error: 'AUTH' }, 401);
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const hash = Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
    const response = await fetch(`${url}/rest/v1/rpc/compta_sync_export`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_token_sha256: hash }),
    });
    if (response.ok) return reply(await response.json());
    const detail = await response.text();
    return detail.includes('COMPTA_AUTH') ? reply({ error: 'AUTH' }, 401) : reply({ error: 'UNAVAILABLE' }, 503);
  } catch {
    return reply({ error: 'UNAVAILABLE' }, 503);
  }
});
