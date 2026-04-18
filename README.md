# 🚨 GestorIncidencias — Centro Educativo

Aplicación web para gestión de incidencias en centros educativos. Single-page app con backend Node.js/Express/SQLite.

## Características

- **Formulario público** — Cualquiera puede enviar una incidencia sin login (nombre, email, descripción, ubicación, prioridad)
- **Panel de gestión** — Con login para gestionar estados, asignar técnico y añadir solución
- **3 niveles de acceso**: `admin`, `cofotap`, `usuario`
- **Estados**: Abierta 🔴 → En proceso 🟡 → Cerrada 🟢 / Reabierta 🟠 / Cancelada
- **Historial de cambios** por incidencia
- **Copiar resumen** completo (incidencia + solución) al portapapeles
- **Gestión de ubicaciones** desde panel admin (añadir, editar, eliminar)
- **Gestión de usuarios** desde panel admin
- **Dashboard** con estadísticas y últimas incidencias abiertas
- **Búsqueda y filtros** en tiempo real
- **Código automático** tipo `INC-2025-0001`

## Arranque rápido con Docker

```bash
git clone <repo>
cd gestor-incidencias

# Cambiar JWT_SECRET en docker-compose.yml primero!
docker-compose up -d
```

Acceder en: http://localhost:3010

## Credenciales por defecto

| Usuario   | Contraseña   | Rol      |
|-----------|-------------|----------|
| admin     | admin123    | admin    |
| cofotap   | cofotap123  | cofotap  |

⚠️ **Cambiar contraseñas en producción** desde el panel de Ajustes → Usuarios

## Roles

| Rol      | Crear | Ver lista | Cambiar estado | Solución | Ubicaciones | Usuarios |
|----------|-------|-----------|---------------|----------|-------------|---------|
| Público  | ✅    | ❌        | ❌            | ❌       | ❌          | ❌      |
| usuario  | ✅    | ✅        | ❌            | ❌       | ❌          | ❌      |
| cofotap  | ✅    | ✅        | ✅            | ✅       | ❌          | ❌      |
| admin    | ✅    | ✅        | ✅            | ✅       | ✅          | ✅      |

## Variables de entorno

```env
PORT=3000
JWT_SECRET=tu_secreto_seguro
DB_PATH=/data/incidencias.db
TZ=Europe/Madrid
```

## Estructura

```
gestor-incidencias/
├── src/
│   └── server.js        # Backend Express + SQLite
├── public/
│   └── index.html       # Frontend SPA (single file)
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## Gmail / Notificaciones por email

La app incluye el email del solicitante y un botón **"Copiar resumen"** que genera
el texto completo listo para pegar en un email. 

Para integración automática con Gmail via nodemailer, añadir al `.env`:
```env
GMAIL_USER=tu@gmail.com
GMAIL_APP_PASSWORD=xxxx_xxxx_xxxx_xxxx
```
Y descomentar el módulo de email en `server.js` (incluido comentado).

## Despliegue en CasaOS / terra

En CasaOS, importar `docker-compose.yml` desde la tienda de apps o usar:
```bash
cd /ruta/del/proyecto
docker-compose up -d
```
El puerto por defecto es **3010**.
