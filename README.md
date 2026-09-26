# شركة الوكلاء

منصة وكلاء ذكاء اصطناعي تدير تجارة على أمازون السعودية وأعمال صاحبها: 32 وكيلًا في ثمانية أقسام حول مركز معرفة، تُعرض كمبنى ثلاثي الأبعاد. كل مهمة تمر عبر المدير التنفيذي إلى القسم ثم الوكيل المختص ثم الأدوات، وكل فعل ذي أثر خارجي يمر ببوابة صلاحيات على الخادم قبل التنفيذ.

- المواصفة الملزمة: [`docs/reference/project-doc.md`](docs/reference/project-doc.md)
- الخطة والمراحل: [`docs/PLAN.md`](docs/PLAN.md)
- المعمارية والأمان: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

## البنية

| المجلد | المحتوى |
|---|---|
| `packages/domain` | الأنواع، البيانات المرجعية (§10 حرفيًا)، قواعد التوجيه والصلاحيات والجدولة والإعداد — مشتركة بين الخادم والواجهة ومغطاة باختبارات |
| `apps/server` | Fastify + TypeScript + PostgreSQL + pg-boss، مشغّل الوكلاء (Claude)، عميل MCP، مركز البائع، الخزنة، البث الحي |
| `apps/web` | واجهة التصميم (three.js، اللوحات، لوحة الإدارة) فوق المحوّل الحي، مبنية بـ Vite |

## التشغيل المحلي

المتطلبات: Node.js 22، pnpm 10، PostgreSQL 14 أو أحدث.

```bash
pnpm install
cp apps/server/.env.example apps/server/.env      # املأ DATABASE_URL وMASTER_KEY وOWNER_PASSWORD وANTHROPIC_API_KEY
pnpm --filter @agents/domain build
pnpm --filter @agents/server migrate              # إنشاء الجداول
pnpm --filter @agents/server cli seed-demo         # اختياري: منتجات ومؤشرات عرض من الوثيقة
pnpm dev:server                                    # الواجهة البرمجية على :8080
pnpm dev:web                                       # الواجهة على :5173 (توجّه /api إلى :8080)
```

لتشغيل أكثر من نسخة خادم خلف موزّع حمل اضبط `EVENT_BUS=pg`.

أو كمنتج مبني واحد: `pnpm build` ثم `WEB_DIST=../web/dist pnpm --filter @agents/server start` وافتح `http://localhost:8080`.

## النشر

```bash
cp apps/server/.env.example .env    # واضبط COOKIE_SECURE=true وTRUST_PROXY=true خلف HTTPS
docker compose up -d --build
```

ضع المنصة خلف HTTPS (Caddy أو Nginx أو منصة الاستضافة). انسخ قاعدة البيانات احتياطيًا مع `MASTER_KEY`؛ بدونه لا يمكن فك مفاتيح الموصلات.

## أوامر الإدارة

```bash
pnpm --filter @agents/server cli set-password        # تغيير كلمة مرور المالك وإنهاء كل الجلسات
pnpm --filter @agents/server cli token:create n8n    # رمز استقبال لأدوات الأتمتة (/api/ingest/* فقط)
pnpm --filter @agents/server cli token:list
pnpm --filter @agents/server cli seed-demo
```

## ربط الأدوات

- **أي أداة عبر MCP:** لوحة الإدارة ← الموصلات ← ربط: رابط خادم MCP ثم «تفويض OAuth» (تفتح نافذة تسجيل الدخول لدى الخدمة، مثل نوشن) أو «مفتاح API». الرموز تُشفَّر ويُجرى اختبار حقيقي؛ أدوات القراءة تعمل مباشرة، وأدوات الكتابة تخضع للصلاحيات، والموصل بصلاحية «قراءة فقط» لا يعرض أدوات الكتابة للوكلاء أصلًا. اضبط `PUBLIC_URL` ليعمل رابط العودة.
- **مركز البائع:** اضبط `SPAPI_CLIENT_ID` و`SPAPI_CLIENT_SECRET` ثم الصق رمز التحديث في موصل «مركز البائع». تُزامن الطلبات والمخزون كل `SPAPI_SYNC_MINUTES` دقيقة، والمنتجات تُطابق بالـ SKU. لتحديث الأسعار والقوائم فعليًا اضبط `SPAPI_SELLER_ID` وامنح الموصل «قراءة وكتابة»؛ التغيير يمر بالصلاحيات أولًا ولا يُسجَّل في المنصة إلا بعد قبول أمازون.
- **إعلانات أمازون:** اضبط `ADS_CLIENT_ID` و`ADS_CLIENT_SECRET` و`ADS_PROFILE_ID` والصق رمز التحديث. يقرأ الوكلاء الحملات، وتُحدَّث بطاقة «حملات نشطة» والإنفاق الإعلاني اليومي في شريط النبض تلقائيًا (تقرير كل ساعة)، وتغيير الميزانيات يمر بالصلاحيات (حد 10% افتراضيًا).
- **البحث في الويب:** يعمل تلقائيًا للأقسام التي تملك الأداة متى ضُبط `ANTHROPIC_API_KEY` (أداة البحث المدمجة في Claude).
- **الملفات وكشوف البنك:** لوحة الإدارة ← البيانات والملفات. كشف البنك بصيغة CSV يحدّث النقد المتاح ومصروفات الشهر (تُتجاهل الحركات المكررة)، وجداول أسعار الشحن متاحة لقسم التوريد، والملفات العامة للأقسام التي تملك «ملفاتك المرفوعة».
- **أدوات الأتمتة (n8n / Make / Zapier):**
  ```bash
  curl -X POST https://your-host/api/ingest/kpi -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
    -d '{"salesToday":1645000,"profitToday":380000,"adSpendToday":230000,"cash":6850000,"ordersToday":21}'
  curl -X POST https://your-host/api/ingest/product -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
    -d '{"sku":"KD-ORG-01","stock":64,"sales7d":41}'
  ```
  المبالغ بالهللة.

## الفحص

```bash
pnpm typecheck && pnpm lint && pnpm test      # الاختبارات تحتاج PostgreSQL (TEST_DATABASE_URL)
pnpm build
E2E_PASSWORD=... pnpm --filter @agents/web e2e   # اختبار متصفح على خادم يعمل
```
