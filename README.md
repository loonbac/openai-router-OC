# OpenAI Router OC

Plugin para OpenCode con rotación multi-cuenta OAuth de OpenAI Codex

[![license](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue)](https://polyformproject.org/licenses/noncommercial/1.0.0/)

## ¿Qué es esto?

OpenCode no tiene soporte nativo para múltiples cuentas de Codex. Este plugin resuelve ese problema proporcionando un proxy HTTP local que rota automáticamente entre múltiples cuentas de ChatGPT Plus/Pro mediante OAuth.

En lugar de depender de una sola cuenta (con sus límites de rate limiting), el plugin distribuye las solicitudes entre varias cuentas, mejorando la disponibilidad y resiliencia.

## Características

- Rotación automática entre múltiples cuentas OAuth
- Dashboard web para gestionar cuentas
- Proxy HTTP local compatible con OpenAI API
- Auto-restart del router cuando se cae
- Multi-instancia resiliente
- Coordenación mediante heartbeat
- Auto-shutdown después de 30s de inactividad

## Arquitectura

```
OpenCode → localhost:47990/v1/chat/completions
  → Plugin (round-robin)
  → chatgpt.com/backend-api/codex/responses
  → SSE response → OpenCode
```

El servidor HTTP (Hono) se embebe directamente dentro del plugin — no usa un proceso separado. El dashboard web corre en el puerto 3434.

## Requisitos previos

- Node.js >= 20
- OpenCode CLI
- Cuentas de ChatGPT Plus/Pro (OAuth)

## Instalación

### Desde GitHub (recomendado)

```bash
git clone https://github.com/loonbac/openai-router-OC.git
cd openai-router-OC
npm install
npm run build
```

### Configurar OpenCode

Agregar el plugin y la configuración del proveedor en `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "/ruta/a/openai-router-OC/dist/index.js"
  ],
  "provider": {
    "openai": {
      "models": {
        "gpt-5.4": {
          "name": "GPT-5.4 (Codex OAuth)",
          "limit": { "context": 272000, "output": 128000 }
        },
        "gpt-5.4-fast": {
          "name": "GPT-5.4 Fast (Codex OAuth)",
          "limit": { "context": 272000, "output": 128000 }
        },
        "gpt-5.5": {
          "name": "GPT-5.5 (Codex OAuth)",
          "limit": { "context": 400000, "output": 128000 }
        },
        "gpt-5.5-fast": {
          "name": "GPT-5.5 Fast (Codex OAuth)",
          "limit": { "context": 400000, "output": 128000 }
        }
      },
      "name": "OpenAI (Codex OAuth)",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:47990/v1"
      }
    }
  }
}
```

## Agregar cuentas

### Mediante el dashboard web

1. Abrir http://localhost:3434 (o http://<ip-servidor>:3434 si es remoto)
2. Click en "Add Account"
3. Iniciar sesión con ChatGPT OAuth
4. La cuenta se guarda automáticamente en `~/.config/opencode-multi-auth/accounts.json`

### Mediante CLI

```bash
opencode-multi-auth add <alias>
opencode-multi-auth status
opencode-multi-auth list
```

## Uso

1. Abrir OpenCode
2. Seleccionar modelo `openai/gpt-5.4` (o cualquier modelo configurado)
3. El plugin rota automáticamente entre las cuentas habilitadas

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `OPENCODE_MULTI_AUTH_ROUTER_PORT` | 47990 | Puerto del proxy HTTP |
| `OPENCODE_MULTI_AUTH_WEB_PORT` | 3434 | Puerto del dashboard web |
| `OPENCODE_MULTI_AUTH_WEB_HOST` | 0.0.0.0 | Host del dashboard web |
| `OPENCODE_MULTI_AUTH_INJECT_MODELS` | 1 | Inyectar modelos en runtime |

## Desarrollo

```bash
npm run dev      # Desarrollo con hot-reload
npm run build    # Compilar TypeScript
npm run lint     # Verificar tipos
```

## Estructura del proyecto

```
src/
├── index.ts          # Plugin principal (router inline + gestión de vida)
├── router.ts         # Servidor HTTP standalone (backup/CLI)
├── heartbeat.ts      # Coordinación multi-instancia
├── web.ts            # Dashboard web para gestión de cuentas
├── cli.ts            # CLI: opencode-multi-auth
├── store.ts          # Almacenamiento de cuentas (accounts.json)
├── rotation.ts       # Lógica de rotación round-robin
├── models.ts         # Definiciones de modelos GPT-5.x
├── auth.ts           # Flujo OAuth de ChatGPT
├── auth-sync.ts      # Sincronización de tokens
├── format.ts         # Transformación de formatos
├── streaming.ts      # Manejo de SSE
├── settings.ts       # Configuración runtime
├── force-mode.ts     # Modo forzar cuenta específica
├── types.ts          # Definiciones de tipos
├── errors.ts         # Mensajes de error estandarizados
├── rate-limits.ts    # Manejo de rate limits
├── codex-auth.ts     # Decodificación JWT
├── logger.ts         # Sistema de logging
├── systemd.ts        # Servicio systemd (opcional)
└── usage-limits.ts   # Límites de uso por cuenta
```

## Flujo de multi-instancia

```
Opencode A abre → plugin carga → arranca router inline + dashboard
Opencode B abre → plugin carga → detecta router activo → no hace nada
Opencode A cierra → router muere (inline) → heartbeat se borra
Opencode B detecta caída → health check falla → arranca su propio router
```

1. Cuando se abre OpenCode, el plugin detecta si ya existe un router activo mediante heartbeat
2. Si no existe, arranca su propio router inline y dashboard
3. Si ya existe, se registra y delega en el router activo
4. Cuando el router activo muere (cierre de OpenCode), las demás instancias detectan la caída y alguna asume el rol

## Licencia

PolyForm Noncommercial 1.0.0

**Uso gratuito para fines no comerciales.**
Modificable y distribuible con créditos.
**Prohibido uso comercial.**

Para uso comercial, contactar al autor.

Basado en [@guard22/opencode-multi-auth-codex](https://github.com/guard22/opencode-multi-auth-codex) bajo licencia MIT.

## Créditos

- Proyecto original: [guard22/opencode-multi-auth-codex](https://github.com/guard22/opencode-multi-auth-codex)
- Framework HTTP: [Hono](https://hono.dev)
- Adaptador Node: [@hono/node-server](https://github.com/honojs/node-server)
