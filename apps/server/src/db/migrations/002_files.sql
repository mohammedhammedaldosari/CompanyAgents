-- ملفات المالك (spec §19: «ملفاتك المرفوعة»، «كشوف البنوك»، «شركات الشحن» عبر الاستيراد)
create table files (
  id           text primary key,
  name         text not null,
  mime         text not null,
  kind         text not null check (kind in ('upload','bank','rates')),
  size         int not null,
  sha256       text not null,
  data         bytea not null,
  text_content text,
  note         text not null default '',
  uploaded_at  timestamptz not null default now()
);
create index files_kind_idx on files (kind, uploaded_at desc);

create table bank_transactions (
  id          bigserial primary key,
  file_id     text not null references files(id) on delete cascade,
  day         date not null,
  description text not null default '',
  amount      bigint not null,          -- halalas; negative = money out
  balance     bigint,                   -- halalas, when the statement has a balance column
  fingerprint text not null unique      -- dedupes the same line across overlapping statements
);
create index bank_tx_day_idx on bank_transactions (day);
