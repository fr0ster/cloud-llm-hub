# Cloud LLM Hub — План видео-презентации (15 минут, русский язык)

> **Аудитория:** новые разработчики (в первую очередь — те, кто будет вносить правки; во вторую — пользователи системы)  
> **Цель:** после просмотра разработчик может самостоятельно: найти нужный модуль, внести изменения, запустить локально, протестировать, задеплоить. При возникновении вопросов — знает куда смотреть.

---

## 0:00–1:00 — Введение и контекст (1 мин)

**Что показывать:** титульный слайд или README.md в браузере

**Что говорить:**
- «Cloud LLM Hub — это enterprise MCP-оркестратор и LLM-агент платформа на базе SAP CAP, которая связывает AI-ассистентов (Cline, Claude Desktop, n8n) и автономных LLM-агентов с SAP ABAP системами»
- Два основных сценария использования:
  1. AI-ассистент → MCP Gateway → оркестрация (auth, destination, connection) → ABAP (разработчик работает с Cline/Claude)
  2. Agent Service → SAP AI Core LLM → автономно выбирает MCP-инструменты → ABAP (LLM-агент)
- «В этом видео я покажу архитектуру, как вносить изменения, и куда смотреть при проблемах»

---

## 1:00–3:00 — Два проекта: cloud-llm-hub и mcp-abap-adt (2 мин)

> ⚠️ **Это ключевой момент — без понимания этого разделения будут проблемы.**

**Что показывать:** диаграмму «Relationship with mcp-abap-adt» из `docs/architechure/ARCHITECTURE.md` (секция 2), затем `package.json` (зависимости `@mcp-abap-adt/*`), затем `mcp-manager.ts` (строка с `new EmbeddableMcpServer`)

**Что говорить:**

1. «Cloud LLM Hub — это НЕ реализация MCP-сервера. Это оркестратор — enterprise-слой, который управляет авторизацией, подключениями, destination-ами и агентным workflow. А вся реализация MCP-протокола и ABAP-инструментов живёт в ОТДЕЛЬНОМ проекте — **mcp-abap-adt**»
2. Открыть **`package.json`** — показать блок зависимостей `@mcp-abap-adt/*`:
   - «Шесть пакетов: `core` — сам MCP-сервер с тулами, `connection` — интерфейс и фабрика подключений к ABAP, `header-validator` — валидация SAP заголовков, `interfaces` — общие типы и константы, `logger` — логгер, `llm-proxy` — LLM-провайдер и агент»
3. Показать диаграмму из ARCHITECTURE.md — «Вот граница ответственности:»
   - **cloud-llm-hub** (оркестратор) отвечает за: HTTP транспорт, аутентификацию XSUAA, маршрутизацию, резолвинг BTP Destination, Cloud Connector, интеграцию с SAP AI Core, агентную оркестрацию
   - **mcp-abap-adt** (компонент) отвечает за: реализацию MCP-протокола, все ABAP/ADT инструменты (чтение классов, поиск объектов, содержимое таблиц), базовые классы подключений, абстракции LLM-провайдеров
4. Открыть **`mcp-manager.ts`**, показать строку `new EmbeddableMcpServer({connection, logger})` — «Вот это и есть точка интеграции. Cloud LLM Hub как оркестратор создаёт connection, инжектит его в MCP-сервер из mcp-abap-adt и управляет полным жизненным циклом: auth → destination → connection → MCP server → transport → cleanup. А Agent Service добавляет сверху LLM-агент, который сам решает какие MCP-инструменты вызывать»
5. «**Правило для разработчика:** если задача — добавить или изменить MCP-тул (новая операция с ABAP) — это правки в mcp-abap-adt, не здесь. Если задача — изменить транспорт, авторизацию, конфигурацию BTP, агентную логику — это правки здесь, в cloud-llm-hub»

---

## 3:00–4:30 — Структура проекта (1.5 мин)

**Что показывать:** дерево файлов в IDE, переключаясь между папками

**Что говорить и показывать поочерёдно:**

- **`srv/`** — «Здесь вся логика бэкенда. Это главная папка для разработчика»
  - Показать файлы: `server.ts`, `mcp-proxy.ts`, `mcp-manager.ts`, `agent-service.ts`, `agent-manager.ts`, `auth.ts`
  - Показать подпапки: `connections/`, `lib/`
- **`app/router/`** — «SAP BTP Approuter, просто маршрутизация, трогать практически никогда не нужно»
- **`test/`** — «Интеграционные тесты (YAML-driven), smoke-тесты, unit-тесты»
- **`tools/`** — «Утилиты: синхронизация конфигурации Cline, обновление токенов, подготовка к деплою»
- **`docs/`** — «Документация. Если что-то непонятно — начинайте здесь»
- **Стек:** TypeScript, SAP CAP (Node.js), SAP Cloud SDK, MCP Protocol SDK, Express

---

## 4:30–7:00 — Два главных потока запросов (2.5 мин)

### 4:30–5:45 — MCP Gateway Flow (основной)

**Что показывать:** открыть `docs/architechure/ARCHITECTURE.md`, секция 6 (Request Lifecycle — MCP Gateway Flow), sequence-диаграмма. Параллельно открывать файлы по ходу объяснения.

**Что говорить:**

1. «Клиент (Cline) отправляет POST на `/mcp/stream/http` с заголовками авторизации и `X-SAP-Destination`»
2. Открыть **`server.ts`** — «Вот здесь `cds.on('bootstrap')` регистрирует Express middleware. Сначала фиксим Content-Type для совместимости с Cline, потом проверяем авторизацию через `requireAuth` → вызов `AuthService.CheckAuth`»
3. Открыть **`mcp-manager.ts`** — «Это ядро. `createMCPServerForRequest()` — для каждого запроса создаём НОВЫЙ connection, НОВЫЙ MCP-сервер, НОВЫЙ transport. Без кеширования. Это ключевое архитектурное решение — stateless per-request»
4. «`extractSapContext()` — читает из заголовков: если есть `X-SAP-Destination` → идём через BTP Destination Service; если нет — прямое подключение (Basic/JWT)»
5. Открыть **`connections/connectionFactory.ts`** — «Фабрика: есть destination → `CloudSdkAbapConnection`; нет → `createAbapConnection` напрямую»
6. «После создания connection, создаётся `EmbeddableMcpServer` из `@mcp-abap-adt/core` — это embedded MCP-сервер, который умеет работать с ABAP через ADT»

### 5:45–7:00 — Agent / LLM Flow

**Что показывать:** sequence-диаграмма из секции 7, параллельно файлы

**Что говорить:**

1. Открыть **`agent-service.ts`** — «OData сервис на `/agent`. Эндпоинт `Chat(message)` — принимает текст, отправляет в SAP AI Core, возвращает ответ»
2. Открыть **`agent-config.ts`** — «Конфигурация агента: модель, температура, max tokens — всё из переменных окружения. AI Core binding из VCAP_SERVICES»
3. Открыть **`agent-manager.ts`** — «Создаёт `SapCoreAIProvider` — получает OAuth2 токен из service binding, делает запрос к SAP AI Core. Важный паттерн: LLM-агент подключает свой MCP-клиент ОБРАТНО к своему же MCP Gateway (`/mcp/stream/http`) — self-loop оркестрация. Агент сам решает какие инструменты вызывать»
4. «Агент кешируется на 30 минут, но это чисто performance-оптимизация»

---

## 7:00–8:15 — Авторизация и безопасность (1.25 мин)

**Что показывать:** `xs-security.json`, `auth.ts`, `auth.cds`, диаграмма Auth из ARCHITECTURE.md

**Что говорить:**

1. Открыть **`xs-security.json`** — «Вот scopes: `proxyAccess`, `MCP_Connect`, `MCP_Read`, `MCP_Admin`, `MCP_Connector`. Role templates группируют scopes. Role collections назначаются пользователям»
2. Открыть **`auth.cds`** + **`auth.ts`** — «AuthService — внутренний CAP-сервис. `CheckAuth()` проверяет что пользователь аутентифицирован. `CheckRoles()` проверяет конкретные роли»
3. «В development режиме — мок-авторизация: alice (MCP_Connector + MCP_Admin), bob (только MCP_Connector). В production — XSUAA JWT»
4. «Два слоя авторизации: внешний (XSUAA — кто ты для Cloud LLM Hub) и внутренний (SAP system auth — как ты подключаешься к ABAP, это из заголовков запроса)»

---

## 8:15–9:30 — Подключения к SAP (1.25 мин)

**Что показывать:** `connections/` папка, диаграмма Connection Strategy из ARCHITECTURE.md

**Что говорить:**

1. «Два пути подключения к ABAP:»
   - **Destination path** — BTP Destination Service. Открыть **`destinationResolver.ts`** — «Резолвит destination через Cloud SDK `getDestination()`. Поддерживает Basic, OAuth2ClientCredentials, OAuth2SAMLBearerAssertion (Principal Propagation)»
   - **Direct path** — заголовки `X-SAP-URL` + `Authorization`. Открыть **`mcp-manager.ts`** строки с `validateAuthHeaders` — «Валидирует заголовки через `@mcp-abap-adt/header-validator`»
2. Открыть **`CloudSdkAbapConnection.ts`** — «Все запросы к ABAP через `executeHttpRequest` из Cloud SDK. Автоматически: резолвинг destination, авторизация, CSRF-токены, Cloud Connector proxy»
3. «Для on-premise: Connectivity Service + Cloud Connector. Смотрите `connectivityProxy.ts` и `BtpOnPremDestinationConnection.ts`»

---

## 9:30–10:45 — Локальная разработка (1.25 мин)

**Что показывать:** терминал, `package.json` scripts, `default-env.json.template`

**Что говорить и демонстрировать:**

1. `npm install` — установить зависимости
2. `cds watch --profile development` — запуск dev-сервера на `localhost:4004`
3. «В development режиме авторизация мок: Basic `alice:` (пустой пароль)»
4. Показать **`env-setup.ts`** — «ВАЖНО: этот файл импортируется ПЕРВЫМ. Он выставляет `MCP_SKIP_AUTO_START=true` чтобы субмодуль `mcp-abap-adt` не запускался автоматически. Если вы добавляете новый файл который импортирует из `@mcp-abap-adt/*` — убедитесь что `env-setup` импортирован раньше»
5. «Для тестирования с реальным BTP: скопируйте `default-env.json.template` → `default-env.json`, заполните credentials. Или `npm run update:env` чтобы стянуть credentials из задеплоенного приложения»
6. «Type-check: `npm run test:check`. Lint: `npm run lint`»

---

## 10:45–12:15 — Как вносить типичные изменения (1.5 мин)

**Что показывать:** примеры в файлах, показывая конкретные строки

**Что говорить:**

### «Хочу добавить новый MCP-тул»
- «Это делается не здесь, а в `@mcp-abap-adt/core`. Cloud LLM Hub — оркестратор, тулы живут в EmbeddableMcpServer»

### «Хочу добавить новый OData эндпоинт»
- «1) Добавьте функцию/action в `.cds` файл (например `mcp-proxy.cds`). 2) Реализуйте handler в соответствующем `.ts` файле. CAP подхватит автоматически»

### «Хочу изменить логику авторизации»
- «Смотрите `auth.ts`. Middleware в `server.ts` вызывает `requireAuth()` → `CheckAuth()`. Если нужна проверка ролей — используйте `CheckRoles()`»

### «Хочу добавить новый тип подключения»
- «Создайте новый класс в `connections/`, реализующий `AbapConnection` interface. Добавьте ветку в `connectionFactory.ts`»

### «Хочу изменить конфигурацию агента»
- «`agent-config.ts` — добавьте новую переменную окружения. Не забудьте добавить её в `mta.yaml` и `.mtaext.template`»

---

## 12:15–13:15 — Деплой на BTP (1 мин)

**Что показывать:** `mta.yaml`, терминал

**Что говорить:**

1. «Сборка: `npm run build:mta` — создаёт `gen/mta_archives/cloud-llm-hub.tar` (~16MB)»
2. «Деплой: `npm run deploy` — деплоит через `cf deploy`»
3. «Конфиденциальные параметры (модель, destination) — через MTA Extension: `cp mta-config.mtaext.template mta-config.mtaext`, заполнить, деплоить с `-e mta-config.mtaext`»
4. Показать `mta.yaml` — «Два модуля: approuter и srv. Четыре сервиса: XSUAA, Destination, Connectivity, AI Core»
5. «После деплоя может потребоваться пересоздать service key: `cf create-service-key cloud-llm-hub-auth mcp`»

---

## 13:15–14:00 — Тестирование (0.75 мин)

**Что показывать:** `test/` папка, терминал

**Что говорить:**

1. **Unit-тесты:** `npm run test:unit` (Jest + ts-jest). Файлы в `test/unit/`
2. **Интеграционные:** `npm test` — YAML-driven. Скопировать `test/integration.yaml.template` → `test/integration.yaml`, заполнить параметры
3. **Smoke-тесты:** `test/smoke/` — ручные скрипты для проверки health и Stream-HTTP
4. **Type-check:** `npm run test:check`
5. **Lint:** `npm run lint` (Biome)
6. «Перед каждым PR: `npm run test:check` + `npm run lint:check` должны проходить без ошибок»

---

## 14:00–15:00 — Где искать ответы и кого спрашивать (1 мин)

**Что показывать:** `docs/` папка, CONTRIBUTING.md, GitHub

**Что говорить:**

### Куда смотреть при проблемах:

| Проблема | Где искать |
|----------|-----------|
| Не понимаю как устроена система | `docs/architechure/ARCHITECTURE.md` — эту архитектурную документацию |
| Ошибка авторизации (401/403) | `srv/auth.ts`, `xs-security.json`, логи `auth-check` и `auth-service` |
| Ошибка подключения к ABAP | `srv/connections/` — логи `mcp-manager`, `destination-resolver` |
| Ошибка MCP-протокола | `srv/server.ts` (handleStreamHTTP), `srv/mcp-manager.ts` |
| Ошибка Agent/LLM | `srv/agent-manager.ts`, `srv/agent-config.ts`, проверить VCAP_SERVICES |
| Проблемы с деплоем | `mta.yaml`, `docs/deployment/`, `DEPLOY_GUIDE.md` |
| Проблемы Cloud Connector | `srv/connections/connectivityProxy.ts`, `mta.yaml` (ConnectorID) |
| Как настроить Cline | `docs/usage/MCP_CONFIG_UPDATE_HOWTO.md`, `tools/update-cline-connection.js` |

### Кого спрашивать:
- «Архитектурные вопросы и code review — мейнтейнер проекта (см. CONTRIBUTORS.md)»
- «Вопросы по SAP BTP инфраструктуре — администратор BTP пространства»
- «Вопросы по mcp-abap-adt субмодулю — смотрите его отдельную документацию»

### Полезные логи для дебага:
- `cds.log('mcp-proxy')` — MCP Gateway
- `cds.log('mcp-manager')` — создание connection/server
- `cds.log('auth-check')` — авторизация
- `cds.log('destination-resolver')` — резолвинг destination
- `cds.log('agent-manager')` — агент и LLM

**Завершение:** «Документация живёт в `docs/`. CONTRIBUTING.md описывает workflow для PR. Если что-то неясно после этого видео — начните с `docs/architechure/ARCHITECTURE.md` и идите по ссылкам»

---

## Чеклист подготовки к записи

- [ ] Открыть проект в IDE
- [ ] Запустить `cds watch --profile development` (чтобы показать работающий сервер)
- [ ] Открыть `docs/architechure/ARCHITECTURE.md` в preview (для диаграмм)
- [ ] Подготовить терминал с примерами команд
- [ ] Проверить что `default-env.json` НЕ виден на экране (секреты!)
- [ ] Подготовить браузер с `localhost:4004` (показать Health endpoint)
