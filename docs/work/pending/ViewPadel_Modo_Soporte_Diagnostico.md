# ViewPadel Desktop - Modo Soporte y Diagnostico

> Documento de implementacion para un agente de desarrollo.
>
> Proyecto: `D:\Dev\ViewPadel\desktop-app`
>
> Estado: pendiente de implementacion.
>
> Esta tarea debe poder desarrollarse en paralelo con:
> `D:\Dev\ViewPadel\viewpadel-backoffice\docs\work\pending\ViewPadel_Backoffice_Soporte_Diagnostico.md`

---

## 1. Objetivo

Agregar a ViewPadel Desktop un **Modo Soporte / Diagnostico** temporal que:

1. Se active mediante un codigo generado por el backoffice.
2. Quede asociado al perfil autenticado y a una sesion de soporte.
3. Permanezca activo exactamente cinco dias desde su activacion.
4. Se desactive automaticamente aunque la aplicacion haya estado cerrada.
5. Pueda revocarse desde el backoffice.
6. Registre eventos operativos estructurados y explicativos.
7. Persista eventos localmente antes de enviarlos a Supabase.
8. Continue funcionando normalmente si el backend de diagnostico esta caido.
9. Nunca exponga secretos, credenciales, tokens ni URLs firmadas en los logs.
10. No altere el comportamiento normal de grabaciones, camaras, R2, sesiones,
    configuracion ni navegacion cuando el modo no esta activo.

La funcionalidad no debe crear una segunda version de la aplicacion. Es una
capacidad opt-in dentro de la misma version.

---

## 2. Regla de compatibilidad

La compatibilidad con la aplicacion existente es prioritaria.

### 2.1. Comportamiento normal

Cuando no existe una sesion de soporte valida:

- La aplicacion funciona como actualmente.
- No se generan eventos diagnosticos de alta granularidad.
- No se ejecutan subidas de logs.
- No se bloquea ningun flujo por fallos de diagnostico.
- No se cambia la autenticacion normal.
- No se cambia el flujo de R2.
- No se cambia el scheduler.
- No se cambia la configuracion de canchas.
- No se cambia la reproduccion, grabacion ni procesamiento de video.

Puede mantenerse el `electron-log` existente como salida tecnica local. El nuevo
logger estructurado debe agregarse como una capa independiente.

### 2.2. Fallos del sistema diagnostico

Un error en cualquiera de estos elementos nunca debe provocar un error de
negocio:

- validacion del codigo;
- persistencia local de un evento;
- serializacion de metadata;
- sanitizacion;
- subida a Supabase;
- reintento;
- limpieza de la cola;
- consulta del estado del modo soporte.

Todos esos errores deben manejarse silenciosamente para el usuario final o
registrarse solamente en el logger tecnico existente, sin lanzar excepciones a
los flujos funcionales.

---

## 3. Contexto tecnico actual

Antes de modificar codigo, leer:

- `..\..\database\schema.sql`
- `..\..\database\database-update.sql`
- `..\..\database\seed-demo.sql`
- `supabase/migrations/20260916_move_courts_to_local_storage.sql`
- `src/main/index.ts`
- `src/main/services/db.service.ts`
- `src/main/services/vault.service.ts`
- `src/main/services/scheduler.service.ts`
- `src/main/services/recorder/recorder.service.ts`
- `src/main/services/ffmpeg.service.ts`
- `src/main/services/r2.service.ts`
- `src/preload/index.ts`
- `src/preload/index.d.ts`
- `src/renderer/src/App.tsx`
- `src/renderer/src/lib/supabase.ts`
- `package.json`

La aplicacion es Electron con:

- proceso principal en `src/main`;
- renderer React en `src/renderer`;
- IPC mediante `@electron-toolkit/preload`;
- Supabase;
- Cloudflare R2;
- FFmpeg;
- `electron-log`;
- `electron-store`.

El proceso principal es la autoridad para:

- secretos locales;
- expiracion del modo soporte;
- cola local;
- sincronizacion;
- identificador de instalacion;
- acceso a APIs sensibles.

No guardar la expiracion solamente en React o en `localStorage`.

---

## 4. Restricciones de la base de datos existente

La feature de soporte debe ser aditiva respecto del esquema actual.

### 4.1. Tablas existentes que no deben romperse

El esquema actual incluye:

- `profiles`, vinculada a `auth.users`;
- `client_configs`, con la configuracion R2 por perfil;
- `courts`;
- `matches`.

La desktop app ya consulta `profiles` y `client_configs` para cargar
configuracion del cliente. No cambiar nombres, tipos ni semantica de esas
columnas como parte de esta feature.

En particular, no modificar:

```text
profiles.id
profiles.is_configured
profiles.role
client_configs.profile_id
client_configs.r2_bucket_name
client_configs.r2_access_key_id
client_configs.r2_secret_access_key
client_configs.r2_endpoint
```

Aunque las credenciales R2 sean sensibles, su migracion es un trabajo
independiente. En esta tarea solo se debe evitar imprimirlas o duplicarlas en
logs.

### 4.2. Courts y matches

La migracion
`supabase/migrations/20260916_move_courts_to_local_storage.sql` establece que:

- las canchas pasan a ser locales en Desktop;
- `matches.court_id` conserva un UUID local estable;
- `matches.court_name` conserva un snapshot historico;
- `matches.court_id` ya no debe tratarse como foreign key cloud a `courts`;
- `matches.profile_id` sigue siendo importante para el alcance del perfil.

El logger debe respetar esta arquitectura. No debe reintroducir consultas a
`courts` ni modificar la persistencia local de canchas. Para diagnosticos de
partidos, usar el `court_id` local y `court_name` si estan disponibles.

### 4.3. RLS y autenticacion

Las politicas existentes son por perfil y utilizan `auth.uid()`. El modo
soporte no debe usar `service_role` dentro de la desktop app ni pedir permisos
administrativos para activar o subir diagnosticos.

El esquema exportado directamente desde Supabase confirma ademas que:

- `courts.profile_id` es nullable;
- `matches.profile_id` es nullable;
- `matches.court_id` no tiene foreign key hacia `courts`;
- `matches.court_name` existe como snapshot;
- `client_configs.profile_id` es unique, pero no esta declarado `NOT NULL`;
- `profiles.role` mantiene como valor por defecto `client`.

La desktop app no debe asumir que `profile_id` siempre existe en registros
historicos. Los eventos de soporte nuevos si deben exigir un perfil autenticado
y una sesion valida.

La activacion y la ingestion deben validar:

- JWT del usuario;
- `profile_id` del usuario;
- `support_session_id`;
- instalacion asociada;
- estado y vencimiento de la sesion.

No ampliar las politicas de `profiles`, `client_configs`, `courts` o `matches`
para hacer funcionar soporte. Crear tablas y funciones separadas.

La auditoria actual tambien confirma que `matches` tiene una politica
historica de lectura publica. El logger no debe incluir payloads completos de
partidos ni asumir que la existencia de esa politica implica que los nuevos
eventos diagnosticos puedan ser publicos. Las tablas de soporte deben empezar
con RLS cerrado y acceso exclusivamente mediante la sesion autenticada y las
funciones definidas para esta feature.

La desktop app nunca debe autenticarse como operador administrativo. Debe
utilizar la sesion normal del cliente y demostrar que:

- el `profile_id` del JWT coincide con el perfil de la sesion;
- el codigo pertenece a ese perfil;
- el `support_session_id` esta activo;
- la sesion no esta revocada ni expirada.

---

## 5. Alcance funcional

### 4.1. Activacion

Agregar una pantalla o modal de activacion en la configuracion de la
aplicacion. Debe permitir introducir un codigo de soporte y confirmar la
activacion.

La UI debe mostrar antes de confirmar:

- que el modo soporte registra informacion tecnica;
- que la sesion dura cinco dias;
- la fecha de expiracion calculada;
- que no deben registrarse secretos;
- que el soporte puede consultar los datos;
- que la aplicacion seguira funcionando si la sincronizacion falla.

No agregar un checkbox libre que permita activar el modo indefinidamente.

### 4.2. Resultado de activacion

Cuando la activacion sea exitosa:

- guardar la sesion en el proceso principal;
- recibir y persistir `supportSessionId`;
- persistir `activatedAt`;
- persistir `expiresAt`;
- persistir un `installationId` estable;
- mostrar una alerta visible en la aplicacion;
- generar `support.mode.activated`;
- iniciar la cola y el uploader si corresponde.

El codigo no debe persistirse en texto plano despues de una activacion exitosa.

### 4.3. Estado visible

Mientras este activo, la aplicacion debe mostrar una indicacion persistente,
por ejemplo:

```text
Modo soporte activo - vence el 14/11/2026 a las 15:40
```

La indicacion debe ser visible desde las vistas principales y no depender
unicamente de una pantalla de configuracion.

El usuario debe poder consultar:

- estado;
- fecha de activacion;
- fecha de expiracion;
- identificador de sesion, o una version corta;
- cantidad aproximada de eventos pendientes;
- ultimo intento de sincronizacion;
- ultimo error de sincronizacion, si existe.

No ofrecer desactivacion manual por parte del usuario en esta primera version,
salvo que el producto lo solicite expresamente. La revocacion remota la realiza
el backoffice.

### 4.4. Expiracion

El modo soporte dura exactamente cinco dias desde `activatedAt`.

La aplicacion debe verificar la expiracion:

- al iniciar Electron;
- al cargar el renderer;
- antes de registrar un nuevo evento diagnostico;
- antes de intentar subir un lote;
- mediante un temporizador mientras esta abierta.

Cuando expire:

- cambiar el estado local a `expired`;
- detener la generacion de eventos de alta granularidad;
- detener subidas diagnosticas nuevas;
- conservar temporalmente los eventos pendientes para permitir una politica de
  cierre definida;
- generar `support.mode.expired` si es posible;
- retirar el banner de modo activo;
- no afectar ninguna funcion de negocio.

La comparacion de fechas debe hacerse en UTC con ISO-8601.

### 4.5. Revocacion

Si el uploader o una consulta de estado informa que la sesion fue revocada:

- marcarla como `revoked`;
- detener nuevas subidas;
- retirar el modo activo;
- no borrar automaticamente eventos locales sin una politica definida;
- generar `support.mode.revoked` si es posible;
- mantener la aplicacion operativa.

---

## 6. Modelo local

Crear un servicio dedicado. No reutilizar `VaultService` para datos no
secretos, salvo que exista una razon clara.

El modelo conceptual es:

```ts
type SupportModeStatus = 'inactive' | 'active' | 'expired' | 'revoked'

interface SupportModeSession {
  status: SupportModeStatus
  supportSessionId: string
  profileId: string | null
  installationId: string
  activatedAt: string
  expiresAt: string
  lastCheckedAt?: string
}
```

El almacenamiento puede ser un `electron-store` dedicado, por ejemplo
`padelview-support`, o una seccion claramente versionada de un store existente.

Debe incluir versionado del esquema para poder migrar instalaciones existentes.

### 5.1. Installation ID

Crear un identificador estable por instalacion. Requisitos:

- generado una sola vez;
- no incluir email, nombre ni datos personales;
- no regenerarse en cada arranque;
- no usarse como secreto;
- poder enviarse como identificador tecnico.

No utilizar el `profileId` como unico identificador de dispositivo.

### 5.2. Perfil activo

La activacion debe exigir una sesion de usuario valida y asociar el soporte al
perfil actual. Si el usuario cierra sesion:

- no borrar la sesion de soporte automaticamente;
- no continuar enviando datos de otro perfil;
- pausar la sincronizacion;
- exigir reautenticacion para reanudarla;
- verificar que el perfil autenticado coincida con el perfil de la sesion.

No enviar logs con un `profileId` de una sesion anterior.

---

## 7. Contrato con Supabase y backoffice

El contrato exacto se coordinara con el documento del backoffice. No inventar
campos distintos sin actualizar ambos documentos.

### 6.1. Operaciones esperadas

La desktop app necesitara operaciones conceptualmente equivalentes a:

```text
support:activate
support:get-status
support:refresh-status
support:enqueue-event
support:flush
support:get-queue-status
```

Si la arquitectura final usa Edge Functions, el renderer no debe llamar
directamente a APIs administrativas.

### 6.2. Activacion

La operacion de activacion debe enviar:

```json
{
  "code": "VP-7K4M-92QX",
  "profileId": "...",
  "installationId": "...",
  "appVersion": "1.5.4"
}
```

La respuesta esperada:

```json
{
  "success": true,
  "supportSessionId": "...",
  "activatedAt": "2026-11-09T15:40:00.000Z",
  "expiresAt": "2026-11-14T15:40:00.000Z"
}
```

No guardar ni devolver secretos administrativos.

### 6.3. Subida de eventos

La aplicacion debe subir eventos asociados a:

- `supportSessionId`;
- `profileId` o un identificador permitido por la politica;
- `installationId`;
- `eventId` idempotente.

La API debe aceptar lotes y rechazar o truncar payloads excesivos.

---

## 8. Logger estructurado

Crear una API central, por ejemplo:

```ts
diagnosticLogger.info('recording.started', {
  component: 'scheduler',
  action: 'start-recording',
  status: 'success',
  metadata: {
    matchId: '...',
    courtId: '...'
  }
})
```

La API debe soportar como minimo:

```text
debug
info
warn
error
fatal
```

No usar `console.log` nuevo para eventos diagnosticos. El logger debe poder
enviar simultaneamente a:

1. `electron-log`, con un mensaje legible;
2. la cola estructurada, solamente si el modo soporte esta activo.

### 7.1. Contrato de evento

```ts
interface DiagnosticEvent {
  eventId: string
  timestamp: string
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  event: string
  component: string
  action: string
  status: 'started' | 'success' | 'failed' | 'cancelled' | 'skipped'
  message: string
  appVersion: string
  platform: string
  installationId: string
  supportSessionId: string
  profileId?: string
  correlationId?: string
  durationMs?: number
  metadata?: Record<string, unknown>
  error?: {
    name?: string
    message: string
    code?: string
    stack?: string
  }
}
```

`timestamp` debe generarse en el proceso principal y usar UTC.

### 7.2. Reglas de mensajes

Un mensaje debe responder:

- que operacion ocurrio;
- sobre que entidad;
- con que resultado;
- cuanto tardo, cuando aplique;
- que error concreto se produjo;
- que contexto permite reproducirlo.

Evitar:

```text
Error
Something failed
No se pudo
```

Preferir:

```text
No se pudo iniciar la grabacion del partido porque FFmpeg termino con codigo 1
despues de 3200 ms.
```

### 7.3. Correlacion

Las operaciones de varios pasos deben compartir un `correlationId`.

Ejemplos:

- iniciar grabacion;
- iniciar stream;
- subir video;
- descubrir un DVR;
- consultar Supabase;
- ejecutar un ciclo del scheduler.

Los eventos `started` y `success`/`failed` de una misma operacion deben poder
relacionarse.

---

## 9. Instrumentacion inicial obligatoria

Instrumentar, sin cambiar la logica funcional:

### Aplicacion

- inicio;
- cierre;
- version;
- sistema operativo;
- modo desarrollo/produccion;
- errores de proceso no controlados;
- rechazos de promesas no controlados.

### Autenticacion y sesion

- inicio de login;
- login exitoso;
- login fallido;
- logout;
- token actualizado;
- sesion expirada;
- cambio de perfil.

Nunca registrar tokens, emails completos ni respuestas de autenticacion
completas.

### IPC

Registrar invocaciones importantes con:

- canal;
- duracion;
- resultado;
- error sanitizado.

No registrar automaticamente todos los argumentos. Definir una lista de
canales permitidos y extractores seguros.

### Scheduler y grabaciones

- ciclo iniciado/finalizado;
- partido seleccionado;
- grabacion iniciada;
- grabacion detenida;
- grabacion cancelada;
- grabacion fallida;
- archivo generado;
- upload iniciado/finalizado/fallido;
- limpieza de temporales;
- recuperacion de grabaciones huérfanas.

No registrar rutas completas si contienen informacion sensible innecesaria.

### 8.1. Contrato minimo del ciclo de una grabacion

Cada grabacion debe tener un `correlationId` propio y emitir, como minimo, esta
secuencia:

```text
recording.scheduled
recording.start_requested
recording.source.resolved
recording.started
recording.ffmpeg.started
recording.heartbeat              cada cinco minutos mientras siga activa
recording.ffmpeg.completed       o recording.ffmpeg.failed
recording.file.ready             o recording.failed
recording.upload.started
recording.upload.completed       o recording.upload.failed
```

Los eventos de error deben identificar:

- `matchId`;
- `courtId` y nombre de cancha;
- perfil;
- fuente utilizada;
- inicio y fin planificados;
- duración esperada;
- duración real;
- cantidad de grabaciones simultaneas;
- codigo de salida del proceso;
- señal de terminacion;
- tamaño y existencia del archivo;
- cola o etapa en la que ocurrió el fallo;
- cola de stderr de FFmpeg, sanitizada.

No registrar cada segundo. El estado de una grabacion activa se informa con un
heartbeat cada cinco minutos y los cambios importantes se informan
inmediatamente. Si hay varias grabaciones simultaneas, cada una conserva su
`correlationId` y sus propios heartbeats; `activeRecordingCount` permite
reconstruir el estado global.

El heartbeat debe detenerse siempre al finalizar, fallar, cancelar o limpiar la
grabacion. Nunca debe quedar un temporizador asociado a una grabacion terminal.

### Camaras, streams y procesos

- descubrimiento;
- probe;
- conexion;
- desconexion;
- timeout;
- stream iniciado/detenido;
- FFmpeg iniciado/terminado;
- MediaMTX iniciado/terminado;
- codigo de salida;
- duracion.

No registrar stderr crudo de FFmpeg si puede contener credenciales.

### Supabase y R2

Registrar:

- operacion;
- tabla o servicio abstracto;
- duracion;
- resultado;
- codigo de error;
- cantidad de filas o bytes cuando sea seguro.

Nunca registrar:

- API keys;
- JWT;
- service role;
- URLs firmadas;
- credenciales R2;
- secretos RTSP;
- cuerpos completos de respuestas.

---

## 10. Sanitizacion y privacidad

Crear un sanitizador central y aplicarlo antes de:

- escribir en la cola;
- escribir en `electron-log`;
- enviar a Supabase;
- mostrar en el visor.

Claves que deben redactarse por defecto:

```text
password
pass
secret
token
access_token
refresh_token
authorization
api_key
service_role
accessKey
secretKey
credential
rtsp
signedUrl
```

El sanitizador debe detectar tambien valores dentro de strings y URLs cuando
sea posible.

El stack trace puede enviarse, pero debe pasar por redaccion de rutas,
argumentos y valores sensibles.

---

## 11. Cola local y uploader

La cola debe ser durable y tolerar:

- cierre abrupto;
- falta de red;
- Supabase caido;
- respuesta parcial;
- duplicacion de requests;
- eventos corruptos;
- disco lleno.

Cada evento debe tener `eventId` unico para soportar idempotencia.

### 10.1. Politica de lotes

Valores iniciales sugeridos:

- flush cada 60 segundos;
- flush al alcanzar 100 eventos;
- lote maximo de 100 eventos;
- payload maximo configurable;
- timeout de request;
- backoff exponencial;
- maximo de reintentos por ciclo;
- prioridad para `error` y `fatal`.

No bloquear la UI esperando un flush.

### 10.2. Limites

Definir y probar:

- limite de eventos pendientes;
- limite de bytes locales;
- limite de metadata;
- truncamiento de mensajes;
- comportamiento ante disco lleno.

Cuando se alcance el limite, preservar errores y descartar primero eventos
`debug` o `info` de menor prioridad. Registrar un resumen de descartes.

### 10.3. Expiracion de la sesion

La subida no debe continuar despues de `expiresAt`, salvo que el contrato
definitivo determine expresamente que se permite un ultimo flush de eventos
generados antes del vencimiento. La decision debe quedar documentada y ser
consistente con la politica de privacidad.

---

## 12. IPC y preload

Agregar canales tipados y limitar el acceso del renderer.

El renderer debe poder:

- solicitar estado;
- iniciar activacion;
- solicitar estado de cola;
- solicitar flush manual;
- escuchar cambios de estado.

El renderer no debe:

- leer archivos de la cola;
- construir eventos confiando en timestamps del navegador;
- guardar secretos;
- decidir si una sesion esta expirada;
- escribir directamente en Supabase con credenciales administrativas.

Actualizar `src/preload/index.d.ts` si se agregan APIs tipadas. Mantener la
convencion de IPC existente si es compatible; no crear APIs duplicadas.

---

## 13. UI requerida

Agregar a configuracion:

1. tarjeta de Modo Soporte;
2. estado actual;
3. formulario de codigo;
4. confirmacion de privacidad;
5. fecha de expiracion;
6. identificador corto de sesion;
7. estado de sincronizacion;
8. cantidad de pendientes;
9. mensajes claros de error.

Errores posibles:

- codigo invalido;
- codigo expirado;
- codigo ya utilizado;
- perfil incorrecto;
- sesion revocada;
- no hay conexion;
- servidor no disponible;
- respuesta incompatible.

La UI nunca debe mostrar detalles tecnicos sensibles ni stack traces completos
al usuario.

---

## 14. Visor local de logs

El visor actual de `logs:view` muestra texto plano. Mejorarlo sin romperlo:

- conservar la accion existente;
- mostrar timestamp;
- permitir filtros por nivel;
- permitir buscar por evento;
- permitir filtrar por componente;
- resaltar errores;
- diferenciar logs tecnicos de eventos diagnosticos;
- evitar cargar archivos ilimitados en memoria;
- no exponer secretos.

Si se implementa una nueva ventana, mantener un fallback al visor actual.

---

## 15. Pruebas obligatorias

### Unitarias

- calculo exacto de cinco dias;
- fechas UTC;
- sesion expirada;
- sesion revocada;
- generacion de `eventId`;
- correlacion;
- sanitizacion de objetos;
- sanitizacion de strings y URLs;
- truncamiento;
- prioridad de eventos;
- serializacion de errores;
- idempotencia.

### Integracion

- activacion exitosa;
- codigo incorrecto;
- codigo expirado;
- perfil diferente;
- reanudacion despues de reiniciar;
- cierre abrupto durante flush;
- red desconectada;
- Supabase devuelve error;
- respuesta parcial;
- cola llena;
- disco lleno;
- revocacion remota;
- expiracion mientras la aplicacion esta abierta.

### Regresion funcional

Verificar que el modo inactivo no cambie:

- login;
- logout;
- scheduler;
- grabaciones;
- previews;
- streams;
- subida a R2;
- configuracion de canchas;
- auto-start;
- notificaciones;
- updater.

---

## 16. Criterios de aceptacion

- [ ] Se puede activar con un codigo valido desde la configuracion.
- [ ] Un codigo invalido no activa el modo.
- [ ] La sesion se guarda en el proceso principal.
- [ ] La sesion sobrevive al reinicio.
- [ ] Expira exactamente a los cinco dias.
- [ ] La expiracion funciona con la aplicacion cerrada.
- [ ] Una sesion revocada deja de generar y subir diagnosticos.
- [ ] Existe un banner visible mientras esta activo.
- [ ] Los eventos tienen timestamp UTC.
- [ ] Los eventos tienen evento, nivel, componente, estado y contexto.
- [ ] Los errores incluyen causa util para soporte.
- [ ] Los secretos se redactan.
- [ ] Los eventos se guardan localmente antes de subirlos.
- [ ] La app sigue funcionando sin red.
- [ ] La subida se hace en lotes.
- [ ] No se usa una service role key dentro de la desktop app.
- [ ] El modo inactivo no genera trafico diagnostico.
- [ ] El flujo actual de R2 y grabaciones permanece intacto.
- [ ] `npm run typecheck` y `npm run build` pasan.

---

## 17. Limites del trabajo

No incluir en esta tarea:

- rediseño general de la aplicacion;
- migracion de canchas;
- cambio de proveedor de almacenamiento;
- reemplazo completo de `electron-log`;
- telemetria permanente para todos los usuarios;
- captura de pantalla;
- captura de audio;
- keylogging;
- envio de secretos;
- cambios en la web publica;
- cambios en el flujo de asignacion de buckets R2.

---

## 18. Coordinacion con el backoffice

El agente de desktop debe detenerse y coordinar si necesita modificar:

- nombres de tablas;
- nombres de columnas;
- contratos de Edge Functions;
- estados de `support_sessions`;
- politicas RLS;
- formato de `DiagnosticEvent`.

El agente no debe crear una tabla alternativa o un contrato paralelo. El
documento del backoffice define la autoridad del modelo de datos compartido.
