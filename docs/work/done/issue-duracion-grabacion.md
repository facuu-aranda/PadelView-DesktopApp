# Issue: grabaciones programadas terminan antes de la duración configurada

## Estado

Análisis previo a implementación. El caso reportado es una prueba real con una cámara detrás de un DVR/NVR: se programaron 90 minutos y el video finalmente subido duró aproximadamente 9 minutos. Todavía no se ha identificado la causa raíz; hace falta correlacionar el partido, el proceso FFmpeg y la fuente RTSP con marcas de tiempo.

## Impacto

El jugador recibe un video incompleto aunque el partido figure como procesado. El club no puede confiar en la duración agendada, y el estado final puede ocultar el hecho de que se subió un archivo parcial.

## Flujo actual encontrado

1. El formulario convierte la duración en minutos a `end_time` y persiste inicio/fin como fechas ISO en Supabase.
2. El scheduler consulta los partidos `SCHEDULED` cada 15 segundos. Considera que debe iniciar cuando está dentro del minuto previo al `start_time` o cuando el partido ya comenzó, mientras `now < end_time`.
3. Para una cancha DVR/NVR, el scheduler resuelve el canal principal por medio de MediaMTX y entrega a FFmpeg el RTSP local del relay.
4. El scheduler calcula los segundos restantes hasta `end_time` y se los pasa a FFmpeg como `-t`.
5. Al cerrarse FFmpeg, el archivo se sube a R2 y el partido pasa a `DONE`; ante algunos cierres no limpios se conserva y sube el archivo parcial.

Referencias: [conversión de duración en App.tsx](../desktop-app/src/renderer/src/App.tsx#L760-L790), [ventana de inicio del scheduler](../desktop-app/src/main/services/scheduler.service.ts#L122-L161), [resolución DVR y cálculo de duración](../desktop-app/src/main/services/scheduler.service.ts#L278-L363), [grabación FFmpeg](../desktop-app/src/main/services/ffmpeg.service.ts#L61-L110), [cierre de proceso y tratamiento parcial](../desktop-app/src/main/services/ffmpeg.service.ts#L139-L183), [subida y estado final](../desktop-app/src/main/services/scheduler.service.ts#L402-L460).

## Qué sabemos y qué no

- El código no contiene un límite fijo de 9 minutos. El tiempo esperado se deriva de `matches.end_time`.
- El scheduler inicia hasta un minuto antes del horario. Por ello, la captura puede durar hasta aproximadamente un minuto más que la duración de turno configurada: el límite de parada sigue siendo el `end_time`.
- FFmpeg recibe explícitamente `-t <segundos restantes>`. Para un partido de 90 minutos iniciado cerca del horario, ese valor debería ser del orden de 90–91 minutos, no 9.
- El relay DVR usa un path de MediaMTX con `sourceOnDemand: true` y no aparece en el servicio un temporizador de 9 minutos. MediaMTX recibe `stopPreview` al completar o fallar la grabación; el path se libera con una demora de 10 segundos y respeta un contador de referencias.
- Antes de la corrección propuesta, si FFmpeg terminaba con código `null` y el archivo superaba 1 MiB, el servicio lo trataba como parcial válido y el scheduler podía subirlo como `DONE`. La implementación actual ya exige una parada manual explícita para aceptar ese parcial y la recuperación de archivos huérfanos los deja en `FAILED` cuando no puede validar su duración.
- La implementación actual del handler de cierre registra `exit code`, `signal`, tiempo transcurrido y el tramo final de stderr redactado; esto permite distinguir mejor un cierre normal, una terminación externa y un error de entrada. Sigue faltando una medición multimedia real y una política de reconexión.
- El problema de refresco visual documentado por separado puede mostrar datos viejos, pero no explica por sí solo que el MP4 realmente mida nueve minutos. Primero hay que medir el archivo y el intervalo real de FFmpeg.

## Evidencia nueva de la prueba local con OBS

Se reprodujo el problema usando varias cámaras simuladas por OBS y la misma instancia de MediaMTX:

- `Cancha OBS`: configurada aproximadamente de 16:15 a 17:15 — `FAILED`.
- `Cancha OBS2`: configurada aproximadamente de 16:15 a 17:45 — `FAILED`.
- `Cancha OBS3`: configurada aproximadamente de 16:15 a 18:15 — `FAILED`.
- `Cancha OBS4`: grabación manual de aproximadamente tres minutos — `DONE`.

La duración configurada no determina el momento del fallo: las tres grabaciones programadas, con duraciones de 60, 90 y 120 minutos, fallaron cerca del mismo minuto, alrededor de los nueve minutos. La grabación manual corta sí terminó correctamente.

Este patrón cambia la prioridad del diagnóstico. Es poco probable que el scheduler esté aplicando un límite fijo de nueve minutos: si el problema fuera `end_time`, las tres grabaciones deberían terminar en momentos diferentes. La hipótesis principal pasa a ser una interrupción común del upstream RTSP alrededor del minuto nueve. En OBS puede ser el fin del `Media Source` o una reconexión del publisher; en un DVR/NVR puede ser el cierre de la sesión, una pérdida temporal de red o un error del origen que MediaMTX propaga al lector. En ambos casos, MediaMTX deja de entregar el RTSP y FFmpeg termina con un error de lectura; el callback `onError` actualiza el partido a `FAILED`.

La grabación manual de tres minutos no contradice esta hipótesis: finaliza antes de que aparezca la interrupción. La prueba con OBS usando un video en loop o una fuente persistente sigue siendo útil para separar “fin de archivo de OBS” de “problema general de estabilidad RTSP”, pero ya no debe considerarse la explicación del caso DVR por sí sola.

No se dispone del log histórico de ese momento. El visor actual sólo lee el archivo activo de `electron-log` cuando se abre desde Desktop; no ofrece búsqueda por `match_id`, no conserva una copia por partido y el código actual no registra la señal de cierre de FFmpeg. Por tanto, el log perdido impide confirmar el mensaje exacto de FFmpeg, pero no impide hacer la prueba de descarte del fin de fuente.

Referencias adicionales: [MediaMTX configura la fuente bajo demanda y el RTSP local](../desktop-app/src/main/services/media-mtx.service.ts#L38-L94) y [configuración de paths DVR](../desktop-app/src/main/services/media-mtx.service.ts#L168-L181), [recuperación de grabaciones/subidas interrumpidas](../desktop-app/src/main/services/scheduler.service.ts#L467-L550).

## Hipótesis a comprobar, sin asumir todavía una causa

| Hipótesis                                                                            | Evidencia que la confirmaría                                                                                                 | Próximo paso                                                                                                                                                     |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| El `end_time` guardado o el `durationSeconds` eran menores a lo esperado             | La fila de `matches` o el log de inicio muestra una diferencia cercana a 9 minutos                                           | Comparar el horario ingresado, `start_time`, `end_time`, el ID del partido y el número de segundos calculado por el scheduler.                                   |
| FFmpeg fue terminado antes de tiempo                                                 | Evento `close` con código `null`, señal del sistema o código de salida distinto de cero                                      | Registrar código y señal, duración de pared, último progreso, motivo de parada y stderr redactado. Revisar también si el proceso padre salió o se cerró Desktop. |
| El stream del DVR/MediaMTX se interrumpió                                            | Errores RTSP en el DVR/relay, path no listo o pérdida de frames/conexión alrededor del minuto 9                              | Correlacionar timestamps de FFmpeg con logs de MediaMTX y del DVR; repetir con la misma cámara y un stream directo si es posible.                                |
| El archivo era parcial pero se subió como si fuera una grabación completa            | El MP4 descargado de R2 mide 9 minutos, aunque el match termine en `DONE`                                                    | Comparar duración/codec/tamaño del MP4 con `start_time` y `end_time`; no inferir duración a partir del estado UI.                                                |
| Windows, energía, red o intervención del operador interrumpieron la tarea            | Suspensión, pérdida de LAN, cierre de sesión, salida de Desktop, botón de detener o proceso de actualización a la misma hora | Mantener un registro de actividad del PC, eventos de Windows, cierre de sesión y acciones del operador durante una reproducción controlada.                      |
| La vista de la app estaba desactualizada, pero el archivo era correcto (o viceversa) | La duración obtenida del MP4 no coincide con lo mostrado en Desktop/Portal                                                   | Verificar el archivo real aparte de la UI y tratarlo como el issue de sincronización hasta confirmar datos de backend.                                           |

La app busca actualizaciones al iniciar y puede descargar una actualización en segundo plano; la instalación actual está asociada al cierre de la app. No hay evidencia de que eso haya ocurrido durante esta prueba, así que debe tratarse como una variable a descartar, no como causa confirmada. La actualización tampoco debería cerrar por sí sola una grabación activa sin que la aplicación salga.

## Instrumentación recomendada antes de corregir

Para una única reproducción controlada, registrar con el mismo `match_id`:

1. Fecha/hora local y zona horaria del PC; horario y duración introducidos.
2. `start_time`, `end_time`, `status`, `error_log` y `video_key` guardados en Supabase antes y después de la ejecución.
3. Hora exacta de entrada a `RECORDING`, valor de `durationSeconds`, URL de origen anonimizada, tipo de fuente (`direct-camera` o `recorder`) y perfil de stream (`main`). Nunca registrar usuario/contraseña RTSP.
4. Cada progreso FFmpeg con hora de pared, segundos transcurridos, duración objetivo, tamaño del archivo y si el proceso sigue vivo.
5. Evento de cierre del proceso: `exit code`, `signal`, duración real y stderr final con credenciales redactadas.
6. Logs de MediaMTX: inicio del path, activación de fuente, desconexiones/reintentos y eliminación del path.
7. Duración real del MP4 local antes de la subida si se puede observar sin modificar la aplicación; si no, descargar el objeto de R2 y consultar su duración con un reproductor/analizador de medios.
8. Si el match quedó `DONE`, comprobar también su `error_log` y el objeto R2; el estado final no es una medida de integridad temporal.

Un primer smoke test de 5–10 minutos verifica la tubería general. La causa reportada requiere después una ejecución larga con la misma ruta DVR/NVR y duración de 90 minutos. Una fuente RTSP falsa con OBS puede probar el scheduler y FFmpeg, pero **no valida** la autenticación, el adaptador del fabricante ni la enumeración de canales del DVR real.

## Soluciones propuestas, priorizadas

### Prioridad 0 — Confirmar la fuente de OBS antes de tocar Desktop

Repetir una prueba de 12 minutos con una de las siguientes alternativas:

1. En cada OBS, usar `Media Source` con un video cuya opción **Loop** esté activada.
2. Usar una fuente de color o una escena fija que no llegue a EOF.
3. Mantener una sola cámara simulada y programar 12 minutos; no probar las cuatro a la vez hasta confirmar la primera.

Si la grabación supera los nueve minutos y sólo finaliza cerca de su `end_time`, la causa inmediata era la fuente de prueba, no la duración del scheduler. Después repetir con las cuatro fuentes para evaluar concurrencia.

### Prioridad 1 — Corregir el diagnóstico de Desktop

Aunque la causa inmediata sea OBS, Desktop necesita hacer visible por qué terminó FFmpeg:

- registrar `exit code`, `signal`, `durationSeconds`, tiempo real transcurrido y `match_id`;
- guardar el último bloque de stderr de FFmpeg en `error_log`, siempre con URLs RTSP redactadas;
- registrar el tamaño y, si es posible, la duración del archivo antes de subirlo;
- registrar explícitamente si el cierre fue por `-t`, por `q`, por pérdida de fuente, por error de entrada o por cierre de la aplicación;
- incluir el `match_id` y la cancha en cada mensaje de MediaMTX relacionado con la fuente.

La pantalla de grabaciones debería mostrar el motivo de `FAILED` o permitir abrir los detalles del partido. El visor general de logs no debe ser la única forma de investigar un fallo.

### Prioridad 2 — Validar el tiempo programado

Antes de iniciar FFmpeg, persistir o registrar la duración calculada y comparar:

```text
end_time - start_time
end_time - now
```

Para las pruebas de 60, 90 y 120 minutos, esos valores deberían diferir entre partidos. Si `durationSeconds` ya es cercano a nueve minutos, el problema está en los datos/horarios. Si es correcto y FFmpeg muere al minuto nueve, el problema está en la fuente o en el proceso.

### Prioridad 3 — Tratar la pérdida de fuente como un estado distinto

Actualmente cualquier error de FFmpeg termina en `FAILED`, que mezcla casos diferentes. Conviene distinguir al menos:

- `FAILED_SOURCE_INTERRUPTED`: la entrada RTSP dejó de entregar datos;
- `FAILED_PROCESS`: FFmpeg terminó con error propio;
- `FAILED_CONFIGURATION`: no se pudo resolver la URL o la cancha;
- `FAILED_UPLOAD`: la grabación terminó, pero R2 falló;
- `PARTIAL`: existe un archivo reproducible, pero es más corto que la ventana esperada.

Si se quiere mantener sólo los cinco estados actuales por compatibilidad, se puede conservar `FAILED` y guardar una causa estructurada adicional. No debe marcarse un archivo parcial como `DONE` sólo porque su subida terminó.

### Prioridad 4 — Recuperación de interrupciones reales

Para cámaras reales o fuentes OBS que se corten temporalmente, evaluar una política explícita:

- reintentar la conexión RTSP durante una ventana corta;
- conservar el proceso y recuperar la entrada si el origen vuelve;
- o grabar segmentos independientes y unir/remuxear sólo cuando se pueda demostrar continuidad.

No conviene añadir flags de reconexión sin confirmar primero el comportamiento del origen. La recuperación debe evitar duplicar, sobrescribir o declarar completo un video con huecos.

### Si el tiempo calculado ya es corto

Corregir primero la conversión/validación de horario y duración del formulario y verificar el valor persistido en UTC. Añadir validación explícita `end_time > start_time` y una prueba que compruebe el número esperado de segundos para 90 minutos, tanto antes del turno como si el scheduler se inicia tarde.

### Si FFmpeg termina inesperadamente

- Diferenciar claramente fin normal por `-t`, stop solicitado por el usuario, cierre por señal y error RTSP.
- No presentar cualquier archivo parcial como una grabación completa: persistir el motivo y decidir si se conserva como parcial recuperable, se marca como fallido o se ofrece al operador.
- Considerar un supervisor/reintento acotado para cortes temporales, cuidando que el resultado no sobrescriba ni mezcle segmentos sin validación.
- Evitar instalar actualizaciones o cerrar la aplicación mientras haya grabaciones/subidas activas; posponer la instalación hasta un punto seguro.

### Si MediaMTX o el DVR cortan la fuente

- Mantener evidencia del estado del path y de las reconexiones durante toda la sesión.
- Revisar timeouts/keepalive del firmware y la configuración RTSP del fabricante con logs, antes de añadir flags FFmpeg a ciegas.
- Evaluar reintento/reconexión del origen y, si es necesario, segmentación temporal con remux al final. El diseño debe conservar una duración verificable y no marcar `DONE` si faltan segmentos.
- Comprobar que el manejo de referencias al preview no libere el path mientras FFmpeg sigue grabando.

### Si el MP4 sí está completo y sólo la UI está atrasada

Resolver la sincronización de datos descrita en [Issue: refresco visual inconsistente](issue-refresco-ui.md); no tocar la duración ni el proceso FFmpeg basándose únicamente en una tarjeta desactualizada.

## Estado de la primera corrección implementada

Los agentes aplicaron una primera corrección en `ffmpeg.service.ts` y `scheduler.service.ts`:

- FFmpeg ahora usa la opción RTSP compatible con el binario incluido, `-timeout 15000000`, para no quedar bloqueado indefinidamente en una lectura RTSP.
- Se registran `exit code`, `signal`, tiempo transcurrido y stderr final redactado.
- Una terminación prematura ya no se considera automáticamente una grabación completa.
- El scheduler agrega contexto de partido/cancha a los errores y valida la ventana temporal.
- La recuperación de archivos huérfanos ya no sube automáticamente un archivo cuya duración no pueda validarse.

El typecheck de Node, Prettier y `git diff --check` pasan correctamente. Esta primera corrección **no implementa todavía reconexión automática ni segmentación**: si el upstream realmente se corta, el partido seguirá quedando `FAILED`, pero ahora debe quedar con evidencia suficiente para identificar la causa y no convertirse silenciosamente en `DONE`.

La parada manual quedó corregida: FFmpeg informa explícitamente que la finalización fue solicitada manualmente y el scheduler permite que el archivo parcial continúe hacia `UPLOADING` en lugar de marcarlo como `FAILED`. La subida termina en `DONE`, representando el video disponible hasta el momento de la detención. Las terminaciones prematuras sin esa marca explícita siguen siendo fallos.

## Plan de prueba recomendado después del diagnóstico

### Prueba A — Fuente OBS persistente

- Una sola instancia de OBS.
- Video de al menos 15 minutos con **Loop** activo o fuente de color.
- Partido programado de 12 minutos.
- Verificar que el archivo dura aproximadamente lo esperado y termina en `DONE`.

### Prueba B — Cuatro fuentes simultáneas

- Cuatro paths RTMP/RTSP distintos (`cancha1` a `cancha4`).
- Duraciones diferenciadas, por ejemplo 2, 4, 6 y 8 minutos.
- Confirmar que los cuatro `durationSeconds` son diferentes y que cada proceso FFmpeg permanece activo hasta su propio límite.
- Revisar CPU, GPU, memoria, red y tamaño de los archivos.

### Prueba C — Fuente que termina deliberadamente

- Desactivar `Loop` y usar un video de aproximadamente nueve minutos.
- Programar 20 minutos.
- Confirmar que Desktop informa una interrupción de fuente clara, conserva el archivo parcial y no lo presenta como grabación completa.

### Prueba D — Fuente DVR/NVR real

- Repetir primero con 12–15 minutos y luego con 90 minutos.
- Correlacionar logs del grabador, MediaMTX y FFmpeg.
- Comparar la duración real del MP4 con la ventana del match.

## Criterios de aceptación propuestos

- Una grabación programada de 90 minutos en la ruta DVR/NVR real produce un archivo reproducible cuya duración cubre la ventana esperada, considerando el pre-roll de hasta un minuto y una tolerancia de finalización definida.
- La transición a `DONE` se produce sólo después de validar que existe un archivo reproducible; un cierre anticipado queda identificado como parcial/fallido, no indistinguible de una grabación completa.
- Si la fuente se cae, la app registra el momento, la causa observable y cualquier intento de recuperación.
- La prueba se repite para cámara directa y DVR/NVR, y se documenta cuál de los dos flujos falla.
- La interfaz refleja el estado persistido automáticamente, pero la evaluación de duración se hace sobre el MP4 real.
