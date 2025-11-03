# Точні шляхи до CAP ендпойнтів

## AuthService (@path: 'auth')

### CheckAuth
- **Метод**: GET
- **URL**: `/odata/v4/auth/CheckAuth()`
- **Параметри**: немає
- **Авторизація**: Не потрібна (але можлива для отримання інформації про користувача)
- **Приклад**: 
  ```bash
  GET http://localhost:4004/odata/v4/auth/CheckAuth()
  ```

### CheckRoles
- **Метод**: GET
- **URL**: `/odata/v4/auth/CheckRoles?required=["MCP_Connector"]`
- **Параметри**: 
  - `required` (array of String) - масив назв ролей, які потрібно перевірити
- **Формат параметра**: JSON масив, URL encoded
- **Авторизація**: Потрібна (перевіряє ролі авторизованого користувача)
- **Приклади**: 
  ```bash
  # Одна роль
  GET http://localhost:4004/odata/v4/auth/CheckRoles?required=["MCP_Connector"]
  
  # Декілька ролей
  GET http://localhost:4004/odata/v4/auth/CheckRoles?required=["MCP_Connector","MCP_Admin"]
  ```

## McpProxyService (@path: 'mcp')

⚠️ **ВАЖЛИВО**: Усі ендпойнти McpProxyService вимагають авторизації з scope `MCP_Connector` (`@requires: 'MCP_Connector'`)

### Health
- **Метод**: GET
- **URL**: `/odata/v4/mcp/Health()`
- **Параметри**: немає
- **Авторизація**: ✅ Обов'язкова - потрібен scope `MCP_Connector`
- **Приклад**: 
  ```bash
  GET http://localhost:4004/odata/v4/mcp/Health()
  Authorization: Basic YWxpY2U6  # для development (alice)
  # або
  Authorization: Bearer <JWT_TOKEN>  # для production
  ```

### ProbeDestination
- **Метод**: GET
- **URL**: `/odata/v4/mcp/ProbeDestination?destination=NAME`
- **Або через позиційний параметр**: `/odata/v4/mcp/ProbeDestination(destination='NAME')`
- **Параметри**: 
  - `destination` (String, обов'язковий) - назва destination
- **Авторизація**: ✅ Обов'язкова - потрібен scope `MCP_Connector`
- **Приклади**: 
  ```bash
  # Через query параметр (рекомендовано)
  GET http://localhost:4004/odata/v4/mcp/ProbeDestination?destination=S4HANA
  
  # Через позиційний параметр
  GET http://localhost:4004/odata/v4/mcp/ProbeDestination(destination='S4HANA')
  ```

### InvokeTool (Deprecated)
- **Метод**: POST
- **URL**: `/odata/v4/mcp/InvokeTool`
- **Статус**: ⚠️ Deprecated - використовуйте `/mcp/stream/sse` або `/mcp/stream/http`

## Важливі правила для OData V4

### 1. Функції з дужками `()`
CAP функції **завжди** викликаються з `()` в кінці:
- ✅ Правильно: `/odata/v4/mcp/Health()`
- ✅ Правильно: `/odata/v4/auth/CheckAuth()`
- ❌ Неправильно: `/odata/v4/mcp/Health`
- ❌ Неправильно: `/odata/v4/auth/CheckAuth`

### 2. Параметри функцій
Можна використовувати два способи:

**A) Query параметри (рекомендовано для масивів і складних типів)**
```
GET /odata/v4/mcp/ProbeDestination?destination=S4HANA
GET /odata/v4/auth/CheckRoles?required=["MCP_Connector"]
```

**B) Позиційні параметри в URL**
```
GET /odata/v4/mcp/ProbeDestination(destination='S4HANA')
GET /odata/v4/auth/CheckRoles(required=['MCP_Connector'])
```

### 3. Масиви в query параметрах
Масиви передаються як JSON, URL encoded:
- ✅ Правильно: `?required=["MCP_Connector"]` (JSON масив)
- ✅ URL encoded: `?required=%5B%22MCP_Connector%22%5D`
- ❌ Неправильно: `?required=MCP_Connector`
- ❌ Неправильно: `?required[]=MCP_Connector`

### 4. Авторизація

#### Development (Basic Auth)
```bash
# alice (MCP_Connector + MCP_Admin)
Authorization: Basic YWxpY2U6

# bob (MCP_Connector)
Authorization: Basic Ym9iOg==
```

#### Production (Bearer JWT)
```bash
Authorization: Bearer <JWT_TOKEN>
```

JWT токен повинен містити scope `MCP_Connector` (або `MCP_Admin`).

## Приклади для Postman

### Health Check (працює тільки з авторизацією!)

```
GET http://localhost:4004/odata/v4/mcp/Health()

Headers:
  Authorization: Basic YWxpY2U6  # alice: (empty password)

Або в production:
  Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
```

### CheckRoles

```
GET http://localhost:4004/odata/v4/auth/CheckRoles?required=["MCP_Connector"]

Headers:
  Authorization: Basic YWxpY2U6  # alice
```

## Troubleshooting

### Помилка: "Service has no handler"
- Перевірте, чи файл handler відповідає імені сервісу:
  - `AuthService` → `srv/auth.ts`
  - `McpProxyService` → `srv/mcp-proxy.ts`

### Помилка: "Forbidden" або "Unauthorized"
- Перевірте, чи Authorization header встановлений
- Перевірте, чи токен містить потрібний scope (`MCP_Connector`)
- Для development перевірте, чи користувач є в `package.json` → `cds.requires.auth[development].users`

### Помилка: "Malformed parameters"
- Перевірте формат масивів: має бути JSON масив `["role"]`, а не рядок `"role"`
- URL encode масиви: `["MCP_Connector"]` → `%5B%22MCP_Connector%22%5D`

## Відмінності між сервісами

| Сервіс | Шлях | Авторизація | Призначення |
|--------|------|-------------|-------------|
| `AuthService` | `/odata/v4/auth/*` | Необов'язкова | Перевірка автентифікації та ролей |
| `McpProxyService` | `/odata/v4/mcp/*` | **Обов'язкова** | MCP proxy функціональність |

