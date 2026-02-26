# RAG: Питання до архітектури та реалізації

## 1) Use Case і продуктова поведінка
- Які саме користувацькі сценарії RAG має покращити в PoC?
  *Наприклад: "Пошук відповіді по внутрішній технічній документації CAP/BTP для саппорт-інженера".*
- Що означає "хороша відповідь" для цих сценаріїв (критерії якості)?
  *Наприклад: "Відповідь містить конкретну інструкцію + посилання на 1-2 джерела, без галюцинацій".*
- Чи мають джерела повертатися за замовчуванням, чи лише за запитом?
  *Наприклад: "У PoC джерела завжди повертаються внизу відповіді".*
- Яка очікувана поведінка, якщо retrieval не повернув релевантних chunk?
  *Наприклад: "Повертаємо відповідь без RAG-контексту і явно пишемо, що релевантні джерела не знайдено".*

## 2) Дані та ingestion
- Які джерела даних входять у PoC (docs, APIs, files, KB)?
  *Наприклад: "Confluence space X + markdown з репозиторію + FAQ у JSON".*
- Хто є owner цих джерел і як часто вони змінюються?
  *Наприклад: "Owner: команда Platform; оновлення 2-3 рази на тиждень".*
- Як саме виконуватиметься ingestion і re-index (batch/manual/triggered)?
  *Наприклад: "Щоденний batch о 02:00 UTC + ручний re-index по кнопці".*
- Чи потрібні metadata-фільтри (tenant, namespace, тип документа, мова)?
  *Наприклад: "Фільтруємо за tenant і типом документа (runbook/policy)".*
- Яка chunking-стратегія очікується як дефолт для PoC corpus?
  *Наприклад: "Chunk size 800 токенів, overlap 120, розбиття по заголовках".*

## 3) Embeddings і retrieval
- Яка embedding-модель є primary (`EMBEDDING_MODEL_ID`) і чому?
  *Наприклад: "`text-embedding-3-large` через кращу якість на технічних запитах".*
- Чи потрібна backup embedding-модель, і яка стратегія перемикання?
  *Наприклад: "Так, backup `text-embedding-3-small`; перемикання через env var без зміни коду".*
- Який стартовий `RAG_TOP_K`, і який максимально дозволений cap?
  *Наприклад: "Старт `top_k=5`, максимум `top_k=10` для контролю latency".*
- Яка similarity-метрика підтримується обраним vector store?
  *Наприклад: "Cosine similarity".*
- Чи потрібен reranking у PoC, чи достатньо базового top-k retrieval?
  *Наприклад: "Для PoC без reranking, додамо на наступному етапі за потреби".*

## 4) Vector store і BTP CF інфраструктура
- Чи доступний SAP HANA vector у цільовому landscape вже зараз?
  *Наприклад: "Так, доступний у subaccount DEV, план `hana-cloud`".*
- Який конкретний fallback для BTP CF погоджено, якщо HANA vector недоступний?
  *Наприклад: "PostgreSQL + pgvector як fallback для DEV/PoC".*
- Який очікуваний розмір індексу, retention-період і прогноз росту?
  *Наприклад: "Початково 1-2 ГБ, retention 180 днів, ріст ~15%/місяць".*
- Який service plan/sizing потрібен (CPU, memory, storage)?
  *Наприклад: "2 vCPU, 8 GB RAM, 50 GB storage для PoC".*
- Які мережеві/connectivity-обмеження є у CF space/subaccount?
  *Наприклад: "Лише приватні endpoint, вихід у публічний інтернет через корпоративний proxy".*

## 5) Prompting і контракт відповіді
- Як саме retrieved context має інжектитися в prompt template?
  *Наприклад: "Окремий блок `Context:` після system prompt, перед user question".*
- Який max token budget дозволено для retrieved context?
  *Наприклад: "До 2000 токенів сумарно на всі chunk".*
- Які поля source metadata обов'язкові у відповіді (`id`, `title`, `uri`, `score`)?
  *Наприклад: "Обов'язково: `title`, `uri`, `score`; `id` - внутрішній".*
- Чи дозволено LLM відповідати, якщо впевненість у контексті низька?
  *Наприклад: "Так, але з дисклеймером і рекомендацією перевірити джерела".*

## 6) Security і compliance
- Чи можуть індексовані дані містити sensitive/confidential інформацію?
  *Наприклад: "Так, але без персональних даних і секретів".*
- Які правила redaction/sanitization потрібні до indexing і prompting?
  *Наприклад: "Вирізаємо токени, паролі, API keys регулярками перед індексацією".*
- Чи є вимоги tenant isolation для vector index і retrieval?
  *Наприклад: "Так, окремий namespace/index на tenant".*
- Які audit-вимоги є до retrieved chunk і згенерованої відповіді?
  *Наприклад: "Логувати query id, ids джерел, timestamp, модель; без зберігання повного тексту".*

## 7) Надійність, fallback та observability
- Що має відбуватись при timeout/error vector store: fail fast чи LLM-only fallback?
  *Наприклад: "У PoC - LLM-only fallback + warning у відповіді".*
- Яка timeout/retry-політика потрібна для embedding і retrieval викликів?
  *Наприклад: "Timeout 2s retrieval, 5s embedding; 2 retry з exponential backoff".*
- Які latency-цілі очікуються (retrieval p95, generation p95)?
  *Наприклад: "retrieval p95 <= 800ms, generation p95 <= 6s".*
- Які logs/metrics є обов'язковими понад baseline:
  - retrieval latency
  - generation latency
  - retrieved chunk count
  *Наприклад: "Додатково: error rate, fallback rate, token usage".*
- Які мінімальні smoke/integration checks потрібні до rollout?
  *Наприклад: "3 smoke-тести: успішний retrieval, empty retrieval, vector timeout".*

## 8) Delivery і ownership
- Хто затверджує архітектурні рішення та fallback-стратегію?
  *Наприклад: "Tech Lead + Platform Owner".*
- Хто є owner ingestion-операцій і index lifecycle після PoC?
  *Наприклад: "Команда Platform Ops".*
- Який Definition of Ready для старту реалізації?
  *Наприклад: "Затверджені рішення по model/vector store, зафіксовані контракти, є test-plan".*
- Який Definition of Done для завершення PoC?
  *Наприклад: "RAG працює end-to-end, є метрики, документація запуску, пройдені smoke-тести".*
