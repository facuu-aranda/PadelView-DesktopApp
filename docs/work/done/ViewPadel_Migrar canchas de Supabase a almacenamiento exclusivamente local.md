# ViewPadel — Migración de canchas de Supabase a almacenamiento exclusivamente local

## Contexto

Estamos trabajando sobre **ViewPadel**, compuesto principalmente por:

* `PadelView-DesktopApp`

  * Electron
  * React
  * TypeScript
  * Supabase
  * FFmpeg
  * Cloudflare R2
* `PadelView-WebApp`

  * Astro SSR
  * Supabase
  * Cloudflare R2
  * Vercel

Antes de modificar código leer obligatoriamente:

* `Docs/ViewPadel-Context-Fusion.md`
* `AGENTS.md`
* `CLAUDE.md`, si existe
* `database.md`

El comportamiento real del código tiene prioridad sobre la documentación.

No asumir que algo está implementado solamente porque existe un servicio, archivo o endpoint.

---

# Objetivo principal

Modificar la arquitectura de ViewPadel para que las **canchas pertenezcan exclusivamente a la instalación local de Desktop**.

Las canchas NO deben almacenarse en Supabase.

Supabase debe seguir almacenando los partidos y demás información cloud necesaria, pero:

```text
courts
```

debe dejar de ser la fuente de verdad de las canchas.

La fuente de verdad de las canchas debe ser almacenamiento persistente local de Electron.

---

# Resultado esperado

Una instalación de ViewPadel Desktop deberá poder:

1. crear una cancha;
2. editarla;
3. eliminarla;
4. almacenar su configuración RTSP;
5. descubrir/configurar cámaras;
6. realizar preview;
7. agendar partidos;
8. iniciar grabaciones manuales;
9. iniciar grabaciones automáticas;
10. reiniciar la aplicación sin perder las canchas;

sin crear, leer, modificar ni eliminar registros de la tabla:

```text
courts
```

en Supabase.

Las canchas deben existir únicamente en el dispositivo donde corre ViewPadel Desktop.

---

# Motivo arquitectónico

Las canchas representan infraestructura física local del club:

* cámaras;
* streams RTSP;
* configuración LAN;
* credenciales locales;
* nombres de cancha;
* parámetros relacionados con hardware.

No necesitamos sincronizar esta configuración entre instalaciones mediante Supabase.

Además queremos minimizar:

* exposición de URLs RTSP;
* exposición de información de infraestructura;
* dependencia cloud para operaciones locales;
* problemas de aislamiento multi-tenant;
* complejidad innecesaria en Supabase.

---

# Situación actual conocida

Actualmente existe CRUD cloud de canchas mediante IPC y Supabase.

Revisar especialmente:

```text
db:get-courts
db:create-court
db:delete-court
```

Actualmente también existe:

```text
src/main/services/local-court.service.ts
```

pero de acuerdo con la documentación este servicio todavía no está integrado.

NO asumir que dicho servicio está correctamente diseñado.

Primero revisarlo completamente.

Puede reutilizarse, modificarse o reemplazarse si fuera necesario.

---

# Arquitectura objetivo

La arquitectura final deberá ser aproximadamente:

```text
Electron Desktop
      |
      |
      +---- LocalCourtService
      |        |
      |        +---- electron-store / storage local
      |
      +---- VaultService
      |        |
      |        +---- credenciales / RTSP / secretos
      |
      +---- Scheduler
      |
      +---- FFmpeg
      |
      +---- R2
      |
      +---- Supabase
               |
               +---- profiles
               +---- matches
               +---- client_configs
```

Pero:

```text
Supabase
   X
   +---- courts
```

Desktop no debe depender de `courts`.

---

# IMPORTANTE: no romper el sistema de partidos

Actualmente existe una relación conceptual entre:

```text
courts
```

y:

```text
matches
```

El agente debe analizar completamente cómo se utiliza actualmente:

```text
matches.court_id
```

antes de eliminar cualquier dependencia.

Buscar referencias en TODO el workspace.

Por ejemplo:

```bash
rg "court_id"
rg "courts"
rg "db:get-courts"
rg "db:create-court"
rg "db:delete-court"
rg "rtsp_url_key"
```

Buscar tanto en:

```text
PadelView-DesktopApp
PadelView-WebApp
database.md
```

---

# Identidad local de una cancha

Cada cancha local debe continuar teniendo un identificador estable.

Usar preferentemente:

```text
UUID
```

generado al crear la cancha.

Ejemplo conceptual:

```ts
type LocalCourt = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}
```

Si el sistema necesita información adicional de cámara/configuración, extender este modelo.

NO utilizar:

```text
nombre de cancha
```

como identificador.

NO utilizar índices de array.

NO utilizar IDs incrementales frágiles.

El ID debe sobrevivir:

* reinicios;
* actualizaciones de Desktop;
* edición de nombre;
* reordenamientos.

---

# Información sensible

No almacenar credenciales RTSP en texto plano innecesariamente.

Revisar el comportamiento actual de:

```text
vault.service.ts
```

y:

```text
safeStorage
```

La configuración sensible debe permanecer separada del objeto de cancha cuando corresponda.

Una arquitectura válida puede ser:

```text
LocalCourt
  id
  name
  metadata no sensible
```

y en vault:

```text
RTSP_URL_{courtId}
```

No duplicar una URL RTSP completa en múltiples almacenamientos.

Debe existir una única fuente de verdad claramente definida.

---

# Resolver la actual doble fuente de verdad RTSP

La documentación indica que actualmente las URLs RTSP pueden provenir de:

```text
courts.rtsp_url_key
```

o:

```text
vault local
```

Esto debe eliminarse.

La nueva arquitectura debe definir:

```text
Vault local = única fuente de verdad del RTSP
```

o una alternativa local equivalente que mantenga los secretos protegidos.

No debe existir dependencia de Supabase para obtener el RTSP.

---

# LocalCourtService

Crear o terminar correctamente:

```text
src/main/services/local-court.service.ts
```

Debe exponer una API clara y pequeña.

Por ejemplo:

```ts
getCourts()
getCourt(id)
createCourt(...)
updateCourt(...)
deleteCourt(id)
```

Adaptar los nombres al estilo real del proyecto.

Debe manejar:

* persistencia;
* validación;
* IDs;
* actualización;
* errores;
* compatibilidad con datos existentes cuando corresponda.

No mezclar directamente lógica de UI en el servicio.

---

# IPC

Crear o adaptar IPC específico para canchas locales.

Preferentemente dejar de utilizar nombres engañosos como:

```text
db:get-courts
db:create-court
db:delete-court
```

si esas acciones ya no consultan DB.

Utilizar contratos equivalentes a:

```text
courts:list
courts:get
courts:create
courts:update
courts:delete
```

o seguir la convención existente del proyecto si existe una mejor.

Actualizar:

```text
src/main/index.ts
src/preload/index.ts
renderer
```

No dejar handlers antiguos activos si ya no son utilizados.

Buscar todos los listeners e invocaciones antes de eliminarlos.

---

# Renderer

Actualizar la UI de:

```text
Canchas
Agenda
Dashboard
Grabación manual
Configuración
```

para obtener las canchas desde almacenamiento local.

La experiencia visual no debe degradarse.

El usuario debe seguir viendo:

* listado de canchas;
* estado;
* preview;
* alta;
* baja;
* edición;
* cámara;
* selector de cancha al crear partido.

---

# Scheduler

Este es uno de los puntos críticos.

Actualmente el scheduler consulta partidos cloud y necesita resolver qué cámara/cancha corresponde al partido.

Después del cambio no podrá depender de:

```text
Supabase courts
```

Debe resolver la cancha utilizando el almacenamiento local.

Analizar cuidadosamente:

```text
src/main/services/scheduler.service.ts
```

El scheduler deberá poder hacer conceptualmente:

```text
match
  -> localCourtId
  -> LocalCourtService
  -> Vault RTSP
  -> FFmpeg
```

Debe seguir funcionando después de reiniciar Electron.

---

# Matches en Supabase

Los partidos deben continuar almacenándose en Supabase.

Sin embargo, NO deben depender de una FK obligatoria contra una fila cloud de:

```text
courts
```

Revisar el esquema real.

Determinar si actualmente:

```text
matches.court_id
```

tiene foreign key contra:

```text
courts.id
```

No asumirlo solamente por `database.md`.

Verificar el esquema real disponible en el proyecto.

---

# Modelo recomendado para matches

Necesitamos poder identificar localmente qué cancha debe grabar el partido y al mismo tiempo conservar información histórica legible en cloud.

Una solución recomendada es almacenar un snapshot mínimo dentro de `matches`.

Ejemplo conceptual:

```text
local_court_id
court_name
```

Donde:

```text
local_court_id
```

es el UUID local de la cancha.

Y:

```text
court_name
```

es el nombre de la cancha en el momento de crear el partido.

Esto permite que un partido histórico continúe mostrando:

```text
Cancha 1
```

aunque posteriormente:

* la cancha sea eliminada;
* cambie de nombre;
* la configuración local cambie.

IMPORTANTE:

No implementar estos nombres de columna automáticamente sin revisar primero el esquema real y referencias existentes.

Si existe una alternativa más limpia compatible con el proyecto, utilizarla y documentarla.

---

# Evitar dependencia histórica

No queremos que un partido ya terminado necesite consultar la cancha local para poder mostrarse en web.

El portal debe poder mostrar el nombre de la cancha a partir de información almacenada en el propio partido.

Por ejemplo:

```text
matches.court_name
```

o equivalente.

Esto es importante porque el portal web no tiene acceso al almacenamiento local de Electron.

---

# Página web del partido

Revisar:

```text
PadelView-WebApp/src/pages/partido/[match_id].astro
```

Actualmente hubo dependencias/inconsistencias relacionadas con:

```text
courts(name)
```

y:

```text
match.court_name
```

La solución final debe dejar esto explícito.

El portal:

```text
/partido/{matchId}
```

NO debe consultar la tabla:

```text
courts
```

para mostrar información del partido.

Debe obtener todo lo necesario del propio `match`.

---

# R2

Actualmente los videos utilizan una key similar a:

```text
videos/court_{courtId}/{YYYY-MM-DD}_{matchId}.mp4
```

Analizar si podemos seguir utilizando el UUID local como:

```text
courtId
```

Si no existe ninguna razón técnica para cambiarlo, mantener el formato para evitar una migración innecesaria.

Un ID local UUID sigue siendo perfectamente válido para construir:

```text
videos/court_{localCourtId}/...
```

No modificar el formato de R2 salvo que exista una razón concreta.

---

# Eliminación de cancha

Eliminar una cancha local NO debe borrar automáticamente partidos históricos.

Debe eliminar:

* configuración local de la cancha;
* RTSP correspondiente;
* configuración de cámara asociada;
* metadata local relacionada.

Pero debe conservar:

* matches históricos;
* videos existentes en R2;
* información histórica de la cancha almacenada dentro del match.

Si existe un partido futuro `SCHEDULED` asociado a esa cancha, definir comportamiento seguro.

Recomendación:

impedir eliminar la cancha si existen partidos `SCHEDULED` futuros asociados a ella, mostrando una explicación al usuario.

Alternativamente permitir la eliminación solamente después de cancelar/reasignar esos partidos.

No dejar partidos programados apuntando silenciosamente a una cancha inexistente.

---

# Edición de cancha

Cambiar:

```text
Cancha 1
```

por:

```text
Cancha Central
```

NO debería modificar retroactivamente el nombre almacenado en partidos históricos.

Los nuevos partidos deberán utilizar el nuevo nombre.

Los partidos existentes conservarán el snapshot que tenían al momento de crearse.

---

# Migración de usuarios existentes

Este punto es obligatorio.

Actualmente puede haber canchas almacenadas en Supabase.

Necesitamos evitar que una actualización haga desaparecer visualmente todas las canchas del usuario.

Implementar una estrategia de migración.

Ejemplo:

al iniciar una versión nueva:

```text
if localCourtsMigrated !== true:
    obtener canchas cloud del usuario actual
    convertirlas a LocalCourt
    copiar RTSP/configuración disponible al almacenamiento local
    validar resultado
    marcar migración completada
```

Pero realizar esta estrategia solamente si resulta viable y segura con el código real.

La migración debe ser:

```text
idempotente
```

Nunca debe crear duplicados cada vez que Desktop inicia.

Utilizar una marca/versionado local como:

```text
courtStorageVersion
```

o equivalente.

---

# Eliminación de registros cloud existentes

NO borrar automáticamente todas las filas de `courts` durante la primera migración sin analizar riesgos.

Separar:

1. migración de lectura;
2. validación local;
3. abandono de dependencia cloud;
4. limpieza posterior de datos.

El objetivo funcional inmediato es que Desktop deje de depender de la tabla cloud.

La eliminación física de datos existentes puede realizarse posteriormente mediante migración SQL/controlada.

---

# database.md / esquema

Actualizar:

```text
database.md
```

para reflejar la arquitectura final.

Si es necesario cambiar columnas de:

```text
matches
```

crear SQL reproducible.

Actualmente el proyecto carece de migraciones SQL versionadas.

Para este cambio, evitar dejar únicamente instrucciones manuales ambiguas.

Crear una migración claramente identificada si el repositorio dispone o puede incorporar una ubicación adecuada para migraciones.

La migración debe contemplar:

* eliminación/modificación de FK;
* nuevas columnas necesarias;
* índices;
* constraints;
* RLS correspondiente.

No destruir datos existentes.

---

# Tabla courts

Después de la migración arquitectónica:

```text
Desktop
```

no debe realizar:

```text
SELECT courts
INSERT courts
UPDATE courts
DELETE courts
```

La tabla podría mantenerse temporalmente por compatibilidad/migración, pero no debe formar parte del funcionamiento normal.

Si se decide eliminarla definitivamente del esquema, hacerlo mediante una migración separada y segura.

---

# RLS

Al dejar de utilizar:

```text
courts
```

revisar las policies relacionadas.

No mantener una policy pública innecesaria de:

```text
SELECT USING true
```

sobre una tabla que ya no debería formar parte del producto.

Sin embargo, no hacer cambios destructivos sin verificar primero dependencias.

---

# Backoffice

Buscar si el backoffice adyacente utiliza:

```text
courts
```

Si únicamente administra perfiles/configuración, no modificarlo innecesariamente.

Si tiene dependencias reales, documentarlas.

El backoffice NO debe ser fuente de verdad de canchas.

---

# Discovery de cámaras

Mantener funcionando:

```text
network:scan-cameras
CameraScannerModal
DiscoveryService
camera-probe.service.ts
camera-snapshot.service.ts
```

si corresponde.

Las cámaras descubiertas deben terminar asociándose a una cancha local.

No deben requerir crear una cancha en Supabase.

---

# Preview RTSP

Mantener:

```text
stream:start
stream:stop
stream:data:{courtId}
```

adaptándolo para trabajar con:

```text
localCourtId
```

La funcionalidad visual actual no debe romperse.

---

# Grabación manual

Una grabación manual debe poder:

1. seleccionar cancha local;
2. crear el `match` cloud correspondiente;
3. guardar snapshot de nombre/ID local;
4. permitir al scheduler resolver la cancha;
5. iniciar FFmpeg;
6. subir a R2;
7. completar el match.

No crear una fila cloud de cancha.

---

# Grabación automática

Flujo objetivo:

```text
Usuario agenda partido
        |
        v
Match guardado en Supabase
        |
        +-- local_court_id
        +-- court_name
        |
        v
Scheduler consulta matches
        |
        v
LocalCourtService.getCourt(local_court_id)
        |
        v
Vault obtiene RTSP
        |
        v
FFmpeg
        |
        v
R2
        |
        v
DONE
```

---

# Manejo de errores

Si el scheduler encuentra:

```text
local_court_id
```

pero la cancha ya no existe localmente:

NO intentar grabar con información incorrecta.

Registrar un error entendible.

El match debe pasar a un estado consistente, probablemente:

```text
FAILED
```

con un `error_log` claro.

No incluir URLs RTSP ni credenciales en logs.

---

# Compatibilidad con recovery

Revisar también la recuperación:

```text
RECORDING
UPLOADING
```

El recovery no debe romperse porque la cancha sea local.

Para reanudar un upload no debería necesitar la cancha.

Para recuperar una grabación que requiera RTSP sí deberá validar la existencia de la cancha local.

---

# Tests

Agregar tests para los aspectos críticos si la infraestructura actual lo permite.

Como mínimo probar:

### LocalCourtService

```text
create
list
get
update
delete
persistencia
```

### Scheduler

```text
match -> local court
```

### Eliminación

```text
no eliminar cancha con SCHEDULED
```

si se implementa esta restricción.

### Snapshot

Verificar que:

```text
renombrar cancha
```

no modifique:

```text
court_name
```

de matches existentes.

---

# Verificación manual obligatoria

Probar el flujo completo:

## Caso 1 — crear cancha

```text
crear cancha
cerrar Desktop
abrir Desktop
```

La cancha debe seguir existiendo.

Supabase no debe recibir una fila `courts`.

---

## Caso 2 — editar

```text
crear cancha
editar nombre
editar RTSP
reiniciar
```

Los cambios deben persistir.

---

## Caso 3 — agenda

```text
crear cancha local
crear partido
```

El match debe existir en Supabase.

La cancha no.

---

## Caso 4 — grabación

```text
SCHEDULED
-> RECORDING
-> UPLOADING
-> DONE
```

Debe funcionar utilizando exclusivamente la configuración local de cancha.

---

## Caso 5 — portal

Abrir:

```text
/partido/{matchId}
```

Debe seguir mostrando correctamente la información del partido sin consultar `courts`.

---

## Caso 6 — eliminación

Eliminar una cancha.

Verificar que:

```text
partidos históricos
videos R2
```

continúan existiendo.

---

## Caso 7 — reinicio

Crear cancha y partido futuro.

Cerrar completamente Desktop.

Volver a abrir.

El scheduler debe continuar pudiendo resolver:

```text
local_court_id -> cancha local
```

---

# Limpieza de código

Eliminar o refactorizar código muerto relacionado con CRUD cloud de canchas.

Buscar:

```text
db:get-courts
db:create-court
db:delete-court
courts
rtsp_url_key
court_id
```

No eliminar referencias sin entenderlas.

No dejar dos sistemas activos simultáneamente.

Al finalizar debe haber una sola fuente de verdad:

```text
Canchas -> local
Matches -> Supabase
Videos -> R2
RTSP -> vault/local seguro
```

---

# Seguridad

No leer ni imprimir:

```text
.env
tokens
service role
R2 credentials
RTSP credentials
```

No introducir secretos nuevos en código.

No imprimir URLs RTSP completas en logs.

---

# Refactor mínimo relacionado

Este cambio probablemente toque:

```text
PadelView-DesktopApp/src/main/index.ts
PadelView-DesktopApp/src/main/services/db.service.ts
PadelView-DesktopApp/src/main/services/local-court.service.ts
PadelView-DesktopApp/src/main/services/vault.service.ts
PadelView-DesktopApp/src/main/services/scheduler.service.ts
PadelView-DesktopApp/src/preload/index.ts
PadelView-DesktopApp/src/renderer/src/App.tsx
PadelView-DesktopApp/src/renderer/src/components/CameraScannerModal.tsx
PadelView-WebApp/src/pages/partido/[match_id].astro
database.md
```

Pero:

NO modificar archivos únicamente porque aparezcan en esta lista.

Primero inspeccionar referencias reales.

---

# Refactor de App.tsx

No convertir esta tarea en una reescritura completa de `App.tsx`.

Sin embargo, si es necesario extraer un hook o servicio pequeño para separar:

```text
court state
court IPC
court persistence
```

hacerlo.

Evitar aumentar todavía más el componente monolítico.

---

# Compatibilidad

No romper:

* Google Login;
* profiles;
* aprovisionamiento;
* R2;
* scheduler;
* FFmpeg;
* preview;
* cámara discovery;
* agenda;
* WhatsApp;
* portal;
* deep link;
* updater.

---

# Criterios de aceptación

La tarea se considera terminada únicamente cuando se cumplan TODOS:

* Las canchas nuevas no se escriben en Supabase.
* Desktop no necesita consultar `courts` para arrancar.
* Las canchas persisten después de reiniciar.
* El RTSP se resuelve localmente.
* Las canchas tienen IDs locales estables.
* Agenda trabaja con canchas locales.
* Scheduler trabaja con canchas locales.
* Grabación manual funciona.
* Grabación automática funciona.
* Upload R2 funciona.
* Recovery continúa funcionando.
* Matches continúan en Supabase.
* El portal continúa funcionando.
* El portal no necesita consultar `courts`.
* El nombre histórico de la cancha queda disponible para un partido.
* Eliminar una cancha no elimina partidos históricos.
* No quedan partidos futuros apuntando silenciosamente a una cancha inexistente.
* No existen dos fuentes de verdad activas para RTSP.
* No se exponen secretos.
* TypeScript pasa.
* Build Desktop pasa.
* Build Web pasa.
* Tests relevantes pasan.
* El diff final fue revisado completamente.

---

# Verificaciones obligatorias

Ejecutar como mínimo:

```bash
npm.cmd run typecheck
npm.cmd run build
```

en Desktop.

Ejecutar:

```bash
npm.cmd run build
```

en Web.

Ejecutar lint/tests relevantes si existen.

Si lint ya falla por problemas preexistentes, diferenciar claramente:

```text
errores previos
```

de:

```text
errores introducidos por esta tarea
```

No declarar completada la tarea si se introdujeron errores nuevos.

---

# Git

Antes de modificar:

```bash
git status
git diff
git branch --show-current
```

Trabajar exclusivamente sobre:

```text
luna-develop
```

No descartar cambios ajenos.

No utilizar silenciosamente:

```text
git reset
git clean
git restore
git stash
```

---

# Entrega Git

Una vez completada y verificada la implementación:

```bash
git add <solo archivos relacionados con esta tarea>
git diff --cached --check
git diff --cached
git commit -m "refactor: move courts to local storage"
git push -u origin luna-develop
git branch --show-current
git status
git log -1 --oneline
```

No utilizar:

```text
git add .
git add -A
git pull
merge
rebase
PR automático
```

---

# Documentación final obligatoria

Actualizar:

```text
Docs/ViewPadel-Context-Fusion.md
```

para dejar explícitamente documentado:

```text
Canchas: almacenamiento exclusivamente local
RTSP: almacenamiento local seguro
Matches: Supabase
Videos: Cloudflare R2
```

Actualizar además:

* modelo de datos;
* arquitectura;
* IPC;
* flujo scheduler;
* matriz de implementación;
* riesgos eliminados;
* riesgos nuevos;
* archivos relevantes;
* resultados de build/typecheck/tests;
* commit final.

---

# Resultado final del agente

Al finalizar informar:

1. qué arquitectura quedó implementada;
2. dónde se almacenan las canchas;
3. dónde se almacena el RTSP;
4. cómo se vincula un match con una cancha local;
5. qué cambios se hicieron en Supabase;
6. cómo funciona la migración de canchas existentes;
7. cómo se comporta la eliminación de una cancha;
8. qué ocurrió con `courts`;
9. archivos modificados;
10. verificaciones ejecutadas y resultados;
11. riesgos o deuda técnica restante;
12. rama;
13. commit;
14. confirmación del push a `luna-develop`.

No declarar la tarea terminada hasta haber validado el flujo end-to-end.
