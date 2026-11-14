-- Export comptable en lecture seule pour « Comptabilité Nowis » (projet nowis-immobilier : immeubles seulement).
-- Une clé donne accès aux données d'une seule organisation; rien n'est modifié dans le CRM.
-- Installation : appliquer ce fichier dans le projet Supabase, déployer functions/compta-sync,
-- puis ajouter une clé (voir README.md, section « Ajouter une clé de synchronisation »).
create table if not exists public.compta_sync_clients (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
alter table public.compta_sync_clients enable row level security;
revoke all on public.compta_sync_clients from anon, authenticated;

create or replace function public.compta_sync_export(p_token_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cid uuid;
  org uuid;
begin
  select c.id, c.organization_id into cid, org
  from public.compta_sync_clients c
  where c.token_sha256 = p_token_sha256 and c.enabled;
  if org is null then
    raise exception using errcode = '42501', message = 'COMPTA_AUTH';
  end if;
  update public.compta_sync_clients set last_used_at = now() where id = cid;

  return jsonb_build_object(
    'genere', now(),
    'organisation', (select o.name from public.organizations o where o.id = org),
    'factures', '[]'::jsonb, 'paiements', '[]'::jsonb, 'dettes', '[]'::jsonb, 'clients', '[]'::jsonb,
    'factures_immeubles', coalesce((select jsonb_agg(jsonb_build_object(
        'id', i.id, 'reference', i.reference, 'emise', i.issued_date, 'echeance', i.due_date,
        'sous_total', i.subtotal_cents, 'tps', i.gst_cents, 'tvq', i.qst_cents, 'taxes', i.tax_cents, 'total', i.total_cents,
        'statut', i.status, 'categorie', i.expense_category, 'immeuble', b.name, 'fournisseur', c.name,
        'version', i.version, 'maj', i.updated_at) order by i.issued_date)
      from public.invoices i
      left join public.buildings b on b.id = i.building_id
      left join public.contacts c on c.id = i.supplier_contact_id
      where i.organization_id = org), '[]'::jsonb),
    'paiements_immeubles', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'facture', p.invoice_id, 'montant', p.amount_cents, 'date', p.paid_on,
        'mode', p.method, 'reference', p.reference, 'statut', p.status) order by p.paid_on)
      from public.invoice_payments p where p.organization_id = org), '[]'::jsonb),
    'loyers', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'montant', p.amount_cents, 'date', p.paid_on, 'mode', p.method, 'reference', p.reference,
        'statut', p.status, 'logement', u.label, 'immeuble', b.name,
        'periodes', (select jsonb_agg(e.period order by e.period)
                     from public.rent_payment_allocations a join public.rent_entries e on e.id = a.rent_entry_id
                     where a.payment_id = p.id)) order by p.paid_on)
      from public.rent_payments p
      left join public.leases l on l.id = p.lease_id
      left join public.units u on u.id = l.unit_id
      left join public.buildings b on b.id = u.building_id
      where p.organization_id = org), '[]'::jsonb),
    'parts', coalesce((select jsonb_agg(jsonb_build_object(
        'immeuble', b.name, 'proprietaire', c.name, 'part', o.share_bps))
      from public.ownerships o
      join public.buildings b on b.id = o.building_id
      join public.contacts c on c.id = o.contact_id
      where o.organization_id = org), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.compta_sync_export(text) from public, anon, authenticated;
grant execute on function public.compta_sync_export(text) to service_role;
