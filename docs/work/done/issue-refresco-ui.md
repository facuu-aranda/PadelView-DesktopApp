# Issue: refresco visual inconsistente en Desktop

## Estado

Primera corrección implementada en `src/renderer/src/App.tsx`. Este documento conserva el análisis, la causa encontrada y los criterios para validar el comportamiento.

## Resumen del problema

La interfaz no siempre refleja el estado más reciente de la aplicación, Supabase o R2. En algunos casos la pantalla conserva datos anteriores hasta que el operador pulsa **Sincronizar**. El ejemplo más visible es un video que ya terminó de subirse y está disponible, pero continúa apareciendo como **Subiendo** hasta la sincronización manual.

El síntoma no parece limitado a una pantalla: el estado compartido alimenta Monitoreo, Agenda, Canchas y la Biblioteca de Videos. También puede afectar información que cambió fuera de esta ventana, por ejemplo desde otro proceso o desde el Backoffice.

## Impacto para el operador

- Puede parecer que una grabación o una subida continúa cuando ya finalizó.
- Puede parecer que una acción falló aunque se haya completado en segundo plano.
- El operador repite acciones o pulsa botones de control innecesariamente.
- La falta de una confirmación oportuna dificulta distinguir un error real de una interfaz desactualizada.
- La pantalla de biblioteca, el uso de R2 y los estados de partidos pueden divergir entre sí hasta una sincronización manual.

## Evidencia encontrada en el código

La función `fetchData` es la carga central de datos. Obtiene configuración, uso de almacenamiento, preferencias, perfil, canchas locales, partidos de Supabase y objetos MP4 de R2. Para cargar canchas, partidos y videos necesita un `profileId`, que obtiene del argumento recibido o de `sessionUser`.

El proceso principal envía eventos `match-updated` cuando cambia el estado de un partido y eventos `recording-progress` / `upload-progress` para actualizar el avance en curso. La UI escucha esos eventos y, al recibir `match-updated`, llama a `fetchData()`.

- [App.tsx: carga central y perfil activo](../desktop-app/src/renderer/src/App.tsx#L507-L610)
- [App.tsx: listeners IPC y `match-updated`](../desktop-app/src/renderer/src/App.tsx#L612-L654)
- [App.tsx: sincronización manual](../desktop-app/src/renderer/src/App.tsx#L1229-L1237)
- [Scheduler: emisiones al cambiar estados](../desktop-app/src/main/services/scheduler.service.ts#L329-L397) y [flujo de subida](../desktop-app/src/main/services/scheduler.service.ts#L402-L461)

La mayoría de las operaciones hechas desde la propia UI también llaman a `fetchData` al terminar. Por eso el problema se nota especialmente en transiciones que llegan de procesos de fondo o de cambios externos, y menos en algunas acciones que ejecuta directamente el operador.

## Causa probable de alto impacto

Hay un defecto concreto en el ciclo de vida del listener IPC:

1. El `useEffect` que registra `match-updated` tiene dependencias `[]`, por lo que el listener se crea una sola vez.
2. Ese listener captura la versión de `fetchData` de la primera renderización.
3. En esa primera renderización `sessionUser` todavía es `null`.
4. `handleMatchUpdated` ejecuta `fetchData()` sin pasar el perfil.
5. La carga central calcula `activeProfileId` desde el `sessionUser` capturado. Si es `null`, no entra en el bloque que vuelve a cargar canchas, partidos y videos.
6. El botón Sincronizar se renderiza después del login y llama a la función de la renderización actual; por eso puede funcionar cuando el listener de fondo no lo hace.

Esta hipótesis encaja directamente con el síntoma “se corrige al sincronizar”. Hay que confirmarla con una prueba de evento después del login, pero la captura de estado inicial se observa en el código. No demuestra por sí sola que explique cada acción o cada pantalla.

## Otras causas posibles que deben contemplarse

- No se encontró una suscripción de Supabase Realtime ni un refresco periódico/focus general para reflejar cambios hechos desde otro cliente.
- Los eventos IPC son más limitados que los datos que muestra la aplicación; un evento de progreso no equivale a una confirmación del estado persistido en Supabase/R2.
- `fetchData` vuelve a consultar varias fuentes de manera secuencial. Si se ejecuta varias veces, puede ser costoso y dos cargas concurrentes podrían terminar fuera de orden.
- No todas las entidades cambian al mismo tiempo: un `match-updated` debería refrescar partidos, pero una edición de perfil, de configuración R2 o de una cancha local puede necesitar invalidar otro conjunto de datos.
- Un fallo de red puede dejar los datos previos visibles; actualmente no hay una indicación uniforme de “datos actualizados hace…” o “no se pudo refrescar”.

## Corrección implementada

- El perfil activo ahora se conserva también en `sessionUserRef`, por lo que los listeners IPC creados al montar el componente no dependen del `sessionUser` inicial, que era `null`.
- Las cargas de datos se serializan: si llega otro evento mientras hay una sincronización en curso, se programa una segunda carga en lugar de permitir respuestas concurrentes fuera de orden.
- `match-updated`, el foco de la ventana, la recuperación de conexión y un intervalo de respaldo de 30 segundos disparan la sincronización del perfil actual.
- La copia al portapapeles ahora espera el resultado de `navigator.clipboard.writeText`, utiliza un fallback con `execCommand('copy')` y sólo muestra éxito cuando la operación realmente terminó. Si falla, muestra un error.
- Se centralizaron las copias del enlace del partido, del UUID y del enlace del modal mediante el mismo helper.

La implementación no agrega todavía Supabase Realtime; el refresco por eventos IPC, foco, conexión e intervalo cubre la operación normal de Desktop y deja Realtime como una mejora posterior para cambios externos.

## Issue asociado: copia intermitente de enlaces

Las copias anteriores llamaban a `navigator.clipboard.writeText` sin `await` ni `catch`, y mostraban un toast de éxito inmediatamente. Si Electron rechazaba la operación o la API no estaba disponible, el usuario veía “copiado” aunque el portapapeles no hubiera cambiado.

La corrección centraliza la operación en `copyTextToClipboard`, espera la promesa, usa un fallback con `document.execCommand('copy')` y sólo informa éxito después de confirmar el resultado. Si ambas estrategias fallan, muestra un error. El helper se utiliza para enlaces de partidos, UUID y enlaces del modal.

## Alternativas de solución

### A. Corregir el listener y el perfil capturado — primer paso recomendado

Hacer que el listener siempre use el perfil activo actual. Opciones de implementación:

- Definir `fetchData` como callback estable con dependencias explícitas y registrar el listener dependiendo de ese callback; o
- Mantener el perfil actual en una `ref` y leerlo dentro del listener IPC; o
- Registrar los listeners cuando la sesión ya tenga perfil y desmontarlos al cambiar de perfil o cerrar sesión.

Cualquiera de estas opciones debe evitar listeners duplicados. No basta con añadir `sessionUser` a dependencias si eso vuelve a registrar listeners sin limpiar correctamente los anteriores.

### B. Unificar la invalidación/refresco de datos

Crear una única capa de sincronización que reciba eventos de UI, IPC y servicios remotos y marque qué datos quedaron desactualizados. Por ejemplo:

- `matches`: agenda, estados de grabación/subida y datos de jugador;
- `courts`: altas, cambios o bajas locales;
- `videos` y `storageUsage`: subida/borrado en R2;
- `profile` y `clientConfig`: cambios de datos del club o configuración del cliente.

Los handlers actuales podrían actualizar optimistamente una entidad cuando la respuesta ya contiene el dato, e invalidar/refrescar el resto sólo cuando haga falta.

### C. Recibir cambios externos

Para reflejar cambios realizados en el Backoffice u otra instalación, valorar una suscripción de Supabase Realtime filtrada por el `profile_id` autenticado, al menos para `matches` y las filas propias de `profiles`/`client_configs`. La suscripción debería:

- instalarse después de conocer la sesión;
- quitarse al cerrar sesión o cambiar el perfil;
- reconectarse tras pérdida de red;
- tratar el evento como invalidación y volver a consultar el dato persistido, no como sustituto de la consulta inicial.

Las canchas y las preferencias que son exclusivamente locales no requieren sincronización remota.

### D. Respaldo y consistencia

- Refrescar al volver a primer plano o al recuperar conexión.
- Mantener un polling de respaldo acotado mientras la aplicación está activa, si Realtime no puede garantizar entrega.
- Debounce/coalescing de varios eventos IPC cercanos, especialmente durante los cambios `RECORDING → UPLOADING → DONE`.
- Evitar que una respuesta vieja sobrescriba una más reciente mediante un contador de solicitud, cancelación o serialización de cargas.
- Mostrar error de sincronización y última hora de actualización; conservar datos previos sin presentarlos silenciosamente como recién confirmados.
- Mantener Sincronizar como acción de recuperación, no como paso requerido del flujo normal.

## Plan de verificación propuesto

1. Iniciar sesión y abrir Monitoreo; confirmar que el perfil y su ID ya están cargados.
2. Simular/esperar un cambio de `matches.status` desde el scheduler y observar si la consulta incluye el perfil actual.
3. Completar una subida y verificar que Agenda, Monitoreo y Videos reflejan `DONE` sin pulsar Sincronizar.
4. Repetir para fallo de grabación, cancelación de subida, creación/eliminación de partido y cambios de cancha.
5. Cambiar un perfil o una configuración desde el Backoffice y validar el comportamiento esperado en Desktop.
6. Desconectar y recuperar la red; confirmar que el estado termina reconciliado y que no quedan listeners duplicados.
7. Añadir pruebas de la función de refresco con perfil nulo/activo y de la recepción de `match-updated`. El repositorio actualmente no muestra una suite de pruebas de UI para cubrir estos casos.

## Criterios de aceptación

- Las transiciones de estado persistidas se reflejan en las pantallas correspondientes sin sincronización manual.
- Todas las pantallas que comparten partidos/canchas/videos muestran la misma fuente de verdad.
- Los cambios hechos desde otra fuente se reflejan en el plazo acordado o quedan claramente identificados como pendientes de sincronización.
- Una respuesta atrasada no puede revertir datos más nuevos.
- Un fallo de refresco no se presenta como si la acción de negocio hubiera fallado o como si siguiera ejecutándose.
- El botón Sincronizar se conserva como respaldo y muestra el estado real de carga/error.

## Fuera de alcance

Este issue trata de la representación y sincronización de datos en la UI. No resuelve por sí mismo una grabación que termina antes del horario; ese flujo se documenta por separado en [Issue: duración incompleta de grabaciones programadas](issue-duracion-grabacion.md).
