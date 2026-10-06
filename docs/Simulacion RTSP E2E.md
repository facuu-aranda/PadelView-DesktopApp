# Guía E2E: cámara simulada con OBS para grabaciones programadas

## Objetivo

Publicar un video de OBS como si fuera una cámara IP RTSP, configurarlo en ViewPadel Desktop como **cámara directa** y comprobar el flujo de agenda → grabación FFmpeg → archivo MP4 → subida R2.

Esta prueba permite investigar el scheduler y FFmpeg sin una cámara física. **No sustituye** una prueba con DVR/NVR real: no cubre ONVIF, credenciales del grabador, adaptadores Hikvision/Dahua ni el relay de MediaMTX que usa la fuente de tipo `recorder`.

## Importante: usar un MediaMTX independiente para OBS

Desktop incluye MediaMTX para el flujo DVR/NVR, pero su configuración interna deshabilita RTMP y ocupa su propio conjunto de puertos locales. Para evitar un conflicto, esta guía inicia una segunda instancia de MediaMTX en puertos distintos. OBS publica por RTMP a esa instancia; Desktop lee el mismo video por RTSP.

La configuración interna de la app no se modifica. El binario incluido en el repositorio está en `desktop-app/resources/bin/mediamtx.exe`; si se está probando una instalación, usar el `mediamtx.exe` incluido en sus recursos.

## Requisitos

- OBS Studio instalado.
- ViewPadel Desktop disponible en la misma PC.
- `mediamtx.exe` del proyecto.
- Para completar también la subida y el Portal: perfil Desktop configurado con credenciales R2 válidas.
- Para una prueba solo de grabación no es necesario validar R2, pero el estado de subida podría terminar en error.

## 1. Crear una configuración de MediaMTX para la prueba

1. Usar `desktop-app/obs-testing` como carpeta de la prueba, separada de los datos de producción.
2. El archivo `desktop-app/obs-testing/mediamtx-obs-test.yml` contiene esta configuración:

```yaml
logLevel: info
rtsp: true
rtspAddress: 127.0.0.1:18554
rtspTransports: [tcp]
rtmp: true
rtmpAddress: 127.0.0.1:11935
hls: false
webrtc: false
srt: false
moq: false
api: false
metrics: false
paths:
  all:
    source: publisher
```

Los puertos `18554` y `11935` son deliberadamente distintos de los que usa el relay interno de Desktop. Si ya están ocupados, cambiar ambos en el YAML y utilizar exactamente los mismos puertos en OBS y en la URL RTSP de la app.

3. Ejecutar el MediaMTX empaquetado desde `resources/bin`. Elegir el comando que corresponda a la carpeta actual de PowerShell:

   **Desde la raíz de `desktop-app`:**

   ```powershell
   .\resources\bin\mediamtx.exe .\obs-testing\mediamtx-obs-test.yml
   ```

   **Desde `desktop-app/obs-testing`:**

   ```powershell
   ..\resources\bin\mediamtx.exe .\mediamtx-obs-test.yml
   ```

4. Dejar abierta la consola. Debe indicar que MediaMTX inició los listeners RTSP y RTMP en `127.0.0.1`. Si muestra “address already in use”, elegir otros puertos y reiniciarlo.

## 2. Preparar una escena de prueba en OBS

1. Crear una escena, por ejemplo `Camara de prueba`.
2. Añadir una fuente de video:
   - **Media Source** con un MP4 local y la opción **Loop** activada, recomendado para una prueba larga; o
   - **Color Source** para comprobar conectividad rápidamente. Un color estático prueba el transporte, pero no sirve para evaluar que la imagen siga avanzando.
3. Ajustar la fuente al lienzo y confirmar que el preview de OBS muestra video.
4. En **Settings → Output → Streaming**, usar un encoder H.264 compatible (x264 o encoder hardware H.264), CBR y un keyframe cada 2 segundos. Un bitrate moderado, por ejemplo 2–4 Mbps, basta para una prueba local.
5. En **Settings → Stream** configurar:
   - **Service:** `Custom...`
   - **Server:** `rtmp://127.0.0.1:11935/live`
   - **Stream Key:** `cancha1`
6. Guardar los cambios y pulsar **Start Streaming**.
7. En la consola de MediaMTX comprobar que recibe la publicación. El path esperado es `/live/cancha1`.

## 3. Validar la fuente RTSP antes de agendar

La URL que Desktop debe consumir es:

```text
rtsp://127.0.0.1:18554/live/cancha1
```

Antes de programar un partido:

1. Mantener OBS transmitiendo.
2. Abrir la URL en un reproductor RTSP, si se tiene uno instalado, o usar el preview de una cancha en Desktop.
3. Confirmar que aparece video y que avanza; verificar que la consola de MediaMTX muestra el lector conectado.
4. Si no hay imagen, no continuar a una prueba de duración: primero corregir la publicación RTMP o el path RTSP.

La guía oficial de MediaMTX describe la publicación desde OBS como cliente RTMP y la composición del path: [OBS Studio → MediaMTX](https://mediamtx.org/docs/publish/obs-studio). La referencia oficial de configuración está en [Configuration file reference](https://mediamtx.org/docs/references/configuration-file).

## 4. Configurar Desktop como una cámara directa

1. Iniciar sesión en Desktop y abrir **Canchas**.
2. Crear una cancha y elegir **Cámara IP directa** (no DVR/NVR).
3. Guardar la URL RTSP anterior en el campo de la fuente.
4. Abrir el preview y comprobar que la cámara aparece como activa.
5. Confirmar que OBS continúa transmitiendo durante toda la prueba.

## 5. Prueba corta de agenda

1. Abrir **Agenda** y programar un partido de prueba con un nombre identificable.
2. Elegir una hora local al menos 2–3 minutos en el futuro y una duración de 5 minutos.
3. No pulsar **Iniciar grabación manual**: el objetivo es probar la ruta programada.
4. Dejar Desktop, OBS y MediaMTX abiertos; no cerrar sesión, apagar el PC ni dejar que Windows entre en suspensión.
5. Observar el cambio `SCHEDULED → RECORDING → UPLOADING → DONE` si R2 está configurado.
6. Confirmar que el MP4 muestra movimiento durante el intervalo esperado. El scheduler puede arrancar hasta un minuto antes del horario: un partido configurado por 5 minutos puede producir aproximadamente 5–6 minutos de captura, más una pequeña latencia de cierre.

## 6. Prueba larga para el incidente de 90 minutos

Una prueba corta confirma la ruta básica; no demuestra estabilidad durante 90 minutos.

1. Reutilizar el video en bucle de OBS y mantener RTMP/RTSP activos.
2. Agendar un partido con duración de **90 minutos**, dejando el inicio unos minutos en el futuro.
3. Anotar el ID del partido, `start_time`, `end_time`, el inicio real de `RECORDING` y el momento en que empieza la subida.
4. Durante la ejecución no cerrar OBS, MediaMTX ni Desktop; impedir suspensión/hibernación y mantener la PC conectada a la red.
5. No detener manualmente la grabación ni terminar procesos FFmpeg.
6. Al finalizar, registrar el estado, el tamaño y la duración real del MP4 descargado desde R2. Si se dispone de `ffprobe` o MediaInfo, guardar también el resultado del análisis.
7. Comparar contra la ventana real: la app puede iniciar hasta un minuto antes del inicio programado, y el límite está ligado a `end_time`.

Para el incidente informado, también se necesita repetir con el DVR/NVR real. Esta cámara simulada prueba el scheduler y FFmpeg con RTSP directo, pero no reproduce las diferencias del adaptador del grabador ni de su firmware.

## Dónde se guarda el archivo y qué conservar

Durante la grabación el archivo temporal se crea como `<match_id>.mp4` dentro de `temp_recordings` bajo `app.getPath('userData')`. Después de una subida exitosa, Desktop elimina el temporal. Si se necesita medir duración, descargar el MP4 de R2 o tomar la medición antes de que la app lo elimine. No confundir el estado visible de la UI con la duración real del archivo.

Para investigar una interrupción, conservar el ID del partido, logs de Desktop y MediaMTX, timestamps y duración real del MP4. No incluir URLs RTSP con credenciales en capturas o logs compartidos.

## Problemas comunes

- **OBS transmite, pero Desktop no ve video:** revisar que el servidor use `11935`, el key sea `cancha1` y la URL RTSP apunte al path `/live/cancha1` en `18554`.
- **MediaMTX informa que no hay publisher:** OBS no está transmitiendo o el Server/Stream Key no coincide con el path esperado.
- **El puerto está ocupado:** cambiar puertos en `mediamtx-obs-test.yml`, OBS y Desktop. No cambiar solo uno.
- **La imagen se congela al terminar el archivo:** activar `Loop` en la fuente Media Source de OBS.
- **El video termina antes de tiempo:** medir el MP4 real y guardar exit code/señal de FFmpeg; una tarjeta vieja en la app puede ser el issue de [refresco visual](issue-refresco-ui.md). Para el flujo de 90 minutos, seguir el diagnóstico de [grabación incompleta](issue-duracion-grabacion.md).

## Cierre

1. Detener OBS con **Stop Streaming**.
2. Detener la instancia de prueba de MediaMTX con `Ctrl+C` en su consola.
3. Confirmar que no quedan streams activos antes de reutilizar los puertos.
