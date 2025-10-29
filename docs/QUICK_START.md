# 🚀 Quick Start: MCP Proxy за 5 хвилин

Швидкий запуск MCP Proxy та підключення через Cline.

---

## ✅ Крок 1: Запуск сервісу (1 хв)

### Відкрий термінал і запусти:

```bash
cd /home/developer/prj/cloud-llm-hub
cds watch --profile development
```

### ✓ Перевір що сервіс запущений:

```bash
curl http://localhost:4004/mcp/Health
```

**Очікуваний результат:**
```json
{
  "status": "UP",
  "timestamp": "2025-10-29T..."
}
```

---

## ✅ Крок 2: Налаштувати Cline MCP конфігурацію (2 хв)

### Варіант A: SSE підключення (рекомендовано)

Створи або відкрий файл конфігурації Cline (зазвичай `~/.config/cline/mcp-settings.json` або в налаштуваннях Cline):

```json
{
  "mcpServers": {
    "cloud-llm-hub": {
      "type": "sse",
      "endpoint": "http://localhost:4004/mcp/stream/sse",
      "headers": {
        "Authorization": "Basic YWxpY2U6"
      },
      "description": "MCP Proxy with SSE (alice user)"
    }
  }
}
```

### Варіант B: Stream-HTTP підключення

```json
{
  "mcpServers": {
    "cloud-llm-hub": {
      "type": "stream-http",
      "endpoint": "http://localhost:4004/mcp/stream/http",
      "headers": {
        "Authorization": "Basic YWxpY2U6",
        "Content-Type": "application/x-ndjson"
      },
      "description": "MCP Proxy with Stream-HTTP (alice user)"
    }
  }
}
```

### Де знаходиться конфігурація Cline?

**VS Code:**
- `Ctrl+Shift+P` → "Cline: Edit MCP Settings"
- Або `~/.vscode/extensions/saoudrizwan.claude-dev-*/mcp-settings.json`

**Cursor:**
- Settings → Extensions → Cline → MCP Settings

**Standalone:**
- `~/.config/cline/mcp-settings.json`

---

## ✅ Крок 3: Перезапустити Cline (30 сек)

1. У VS Code/Cursor:
   - `Ctrl+Shift+P` → "Reload Window"
   - Або перезапустити Cline extension

2. Відкрити Cline panel і перевірити підключення

---

## ✅ Крок 4: Перевірка підключення (1 хв)

### У Cline чаті спробуй команду:

```
@mcp list tools
```

або

```
Show me available MCP tools
```

### ✓ Очікуваний результат:

Cline має показати список доступних MCP функцій/tools з `mcp-abap-adt` backend.

**Приклад виводу:**
```
Available MCP Tools:
- tool1: Description of tool 1
- tool2: Description of tool 2
- ...
```

---

## 🔧 Troubleshooting

### ❌ Cline не бачить MCP сервер

**Причина:** Невірний формат конфігурації або Authorization header

**Рішення:**
1. Перевір що `Authorization: Basic YWxpY2U6` (це alice користувач)
2. Переконайся що endpoint правильний: `http://localhost:4004/mcp/stream/sse`
3. Перезапусти Cline / Reload window

### ❌ Connection refused або timeout

**Причина:** Сервіс не запущений

**Рішення:**
```bash
# Перевір чи запущений
curl http://localhost:4004/mcp/Health

# Якщо ні - запусти
cd /home/developer/prj/cloud-llm-hub
cds watch --profile development
```

### ❌ 401 Unauthorized

**Причина:** Невірний Authorization header

**Рішення:**
Згенеруй правильний Base64:
```bash
echo -n "alice:" | base64
# Результат: YWxpY2U6
```

Використай у Cline config:
```json
"Authorization": "Basic YWxpY2U6"
```

### ❌ 403 Forbidden

**Причина:** Користувач не має ролі `MCP_Connector`

**Рішення:**
Використай `alice` або `bob` (обидва мають роль):
```bash
# alice
echo -n "alice:" | base64
# YWxpY2U6

# bob
echo -n "bob:" | base64
# Ym9iOg==
```

### ❌ MCP backend не працює

**Причина:** `mcp-abap-adt` backend не запущений

**Рішення:**
```bash
# Підняти backend (якщо встановлений)
cd external/mcp-abap-adt
npm install
npm start

# Перевірити
curl http://127.0.0.1:7070/health
```

**Примітка:** Якщо backend не встановлений, proxy буде повертати помилку upstream. Це нормально для тестування авторизації.

---

## 🧪 Швидка перевірка авторизації

### Без Cline - через curl:

```bash
# SSE (має показати retry та heartbeat)
timeout 5 curl -N \
  -H "Accept: text/event-stream" \
  -H "Authorization: Basic YWxpY2U6" \
  http://localhost:4004/mcp/stream/sse

# Stream-HTTP (має прийняти запит)
echo '{"command":"test"}' | \
curl -X POST \
  -H "Content-Type: application/x-ndjson" \
  -H "Authorization: Basic YWxpY2U6" \
  --data-binary @- \
  http://localhost:4004/mcp/stream/http
```

---

## 📊 Перевірочний чеклист

- [ ] Сервіс запущений: `curl http://localhost:4004/mcp/Health` повертає 200
- [ ] Cline конфігурація створена з правильним endpoint та Authorization
- [ ] Cline перезапущений (Reload window)
- [ ] Cline показує доступні MCP tools
- [ ] (Опційно) Backend `mcp-abap-adt` запущений

---

## 📝 Готові конфігурації

Я вже створив готові приклади в `docs/examples/`:

### Для development (локально):
- `docs/examples/cline-sse-dev.json` - SSE підключення
- `docs/examples/cline-stream-dev.json` - Stream-HTTP підключення

### Для production (BTP):
- `docs/examples/cline-sse-prod.json` - SSE з JWT токеном

**Копіюй потрібний файл у Cline конфігурацію!**

---

## 🎯 Що далі?

### Якщо все працює:

1. **Протестуй MCP команди** через Cline
2. **Перевір логи** сервера (термінал де запущено `cds watch`)
3. **Додай інших користувачів** (bob) для тестування різних ролей

### Якщо потрібен production режим:

1. Deploy на BTP: `cf push`
2. Bind XSUAA: `cf bind-service cloud-llm-hub mcp-xsuaa`
3. Отримати JWT token через OAuth2
4. Використати prod конфігурацію з Bearer token

---

## 💡 Корисні команди

```bash
# Запустити сервіс
cd /home/developer/prj/cloud-llm-hub && cds watch --profile development

# Перевірити health
curl http://localhost:4004/mcp/Health | jq .

# Швидкий SSE тест
timeout 3 curl -N -H "Accept: text/event-stream" -H "Authorization: Basic YWxpY2U6" http://localhost:4004/mcp/stream/sse

# Автоматичні тести
cd test/smoke && ./test-auth-interactive.sh
```

---

## 📚 Детальна документація

- **Повний testing guide**: `docs/TESTING_GUIDE.md`
- **Cheat sheet з командами**: `docs/TESTING_CHEAT_SHEET.md`
- **Usage guide**: `docs/MCP_PROXY_USAGE.md`
- **Implementation report**: `docs/IMPLEMENTATION_REPORT.md`

---

**Готово!** За 5 хвилин ти маєш працюючий MCP Proxy підключений до Cline! 🎉

Якщо щось не працює - дивись секцію Troubleshooting вище або запускай автоматичні тести: `cd test/smoke && ./test-auth-interactive.sh`
