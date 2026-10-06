# Análisis: actualización de ViewPadel Desktop sin reinstalación manual

## Estado

Análisis de la arquitectura actual y alternativas. No se ha modificado ni ejecutado el updater. La recomendación es mejorar el flujo existente antes de sustituirlo.

## Conclusión ejecutiva

El proyecto ya tiene la base para actualizar Windows sin que el usuario desinstale y vuelva a instalar manualmente: usa `electron-updater`, `electron-builder` con target NSIS y publicación en GitHub Releases. En producción, la app busca una versión al iniciar, descarga la actualización disponible y configura su instalación al salir de la aplicación.

La principal carencia actual es de **experiencia y control operativo**: no se muestra al usuario cuándo se busca/descarga una versión ni cuándo está lista; además, no hay una protección explícita para evitar salir e instalar mientras hay una grabación o una subida activa. Por eso puede parecer que la actualización no existe o que necesita intervención manual, y un cierre durante una operación puede ser riesgoso.

## Implementación visual realizada

La Desktop ahora incorpora la primera versión del flujo visual de actualización:

- eventos IPC para comprobar, descargar, mostrar progreso, informar descarga completa y reportar errores;
- modal de nueva versión con botones **Actualizar ahora**, **Más tarde** y **No actualizar**;
- modal de changelog basado en `src/renderer/src/update-changelog.json`, editable por el equipo;
- botón **Reiniciar y actualizar** cuando el instalador ya fue descargado;
- bloqueo de instalación mientras existan grabaciones FFmpeg o subidas R2 activas;
- versión actual visible en la sección Configuración;
- instalación explícita, sin instalar automáticamente al cerrar la aplicación.

La funcionalidad requiere validación en una instalación empaquetada publicada en GitHub Releases; `npm run dev` no ejecuta el flujo real de actualización.

## Situación actual verificada

| Área                          | Configuración encontrada                                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Versión de Desktop            | `1.5.0` en `desktop-app/package.json`.                                                                                                        |
| Updater                       | `electron-updater` fijado en el lockfile en `6.8.9`.                                                                                          |
| Builder                       | Se declara `electron-builder` `^26.0.12`; el lockfile resuelve `26.15.3`.                                                                     |
| Instalador Windows            | Target NSIS y nombre de artefacto `ViewPadel-Setup`.                                                                                          |
| Publicación                   | GitHub Releases, configurado para el repositorio indicado en `electron-builder.yml`.                                                          |
| Automatización de release     | Workflow de GitHub Actions en Windows, disparado por tags `v*`; ejecuta el build de Windows y publica usando `GITHUB_TOKEN`.                  |
| Comprobación de actualización | Sólo en la app empaquetada, al iniciar. No encontré un timer de comprobación mientras permanece abierta.                                      |
| Descarga                      | `autoDownload` está desactivado; la descarga se inicia únicamente cuando el usuario pulsa **Actualizar ahora** en el modal.                   |
| Instalación                   | `autoInstallOnAppQuit` está desactivado; la instalación se inicia explícitamente desde el modal y se bloquea con grabaciones/subidas activas. |

Referencias: [package.json](../desktop-app/package.json#L1-L21), [electron-builder.yml](../desktop-app/electron-builder.yml#L1-L48), [workflow de publicación](../desktop-app/.github/workflows/release.yml#L1-L29) y [configuración del updater](../desktop-app/src/main/index.ts#L1083-L1103).

## Qué experimenta hoy el usuario

1. La comprobación sólo sucede al abrir la versión instalada.
2. Si encuentra una versión, la descarga se inicia desde el proceso principal.
3. Al terminar, sólo se registra un mensaje en el log.
4. Con `autoInstallOnAppQuit: false`, la aplicación sólo instala la actualización cuando el usuario pulsa explícitamente el botón correspondiente y no existen grabaciones/subidas activas.
5. La meta es una actualización sobre la instalación existente, no pedir al usuario que borre primero la aplicación. Los datos de Electron en `userData` están separados de los archivos versionados de la app, pero su conservación debe probarse con un upgrade real.

El listener de `update-available` se registra inmediatamente después de llamar a `checkForUpdatesAndNotify()`. Es más robusto registrar todos los eventos antes de iniciar la comprobación, aunque la llamada sea asíncrona.

## Flujo para publicar una versión

1. Incrementar `version` en `desktop-app/package.json` con SemVer, por ejemplo `1.5.1` para un cambio compatible.
2. Crear y publicar un tag `vX.Y.Z` que coincida con la versión empaquetada.
3. El workflow de GitHub Actions construye Windows y ejecuta `electron-builder` con publicación habilitada.
4. `electron-builder` genera y publica el instalador NSIS, el manifiesto de actualización y los metadatos requeridos por `electron-updater`.
5. Las instalaciones empaquetadas consultan GitHub Releases en su siguiente inicio y procesan la versión más nueva compatible.

No se encontró un feed configurado manualmente en el código; `electron-builder` genera la configuración de actualización para la aplicación empaquetada. La documentación recomienda no configurar manualmente `setFeedURL` cuando se usa la configuración de publicación de electron-builder.

## Opción recomendada: mantener NSIS + electron-updater y añadir control visible

Es la menor ruptura y utiliza lo que el proyecto ya tiene. Recomiendo implementarlo en dos etapas.

### Etapa 1: validar la ruta actual en una instalación de prueba

- Instalar una release real en una VM o PC de prueba; `npm run dev` no valida el mecanismo instalado.
- Publicar una versión de parche con tag coincidente y confirmar que el release contiene el NSIS, metadatos y checksum.
- Abrir una versión anterior, esperar la detección/descarga y cerrar la app normalmente; confirmar que la nueva versión queda instalada sin desinstalación manual.
- Confirmar que canchas, credenciales del vault, preferencias y datos locales siguen disponibles.
- Probar también sin red, con una versión ya actualizada y con un release incompleto para observar el comportamiento de error.

### Etapa 2: experiencia y protección de operaciones

Enviar desde el proceso principal a la UI eventos para:

- comprobando actualizaciones;
- no hay actualización;
- actualización disponible;
- progreso de descarga;
- descarga terminada;
- error y opción de reintentar.

Cuando esté descargada, mostrar una notificación/panel con **Reiniciar y actualizar** y **Más tarde**. El proceso principal debería conocer si hay grabaciones FFmpeg o subidas R2 activas y no forzar una salida en medio de una operación. Una alternativa segura es dejar la actualización preparada y ofrecer el reinicio al finalizar el trabajo activo.

Con el comportamiento implementado de `electron-updater` 6.8.9, `autoInstallOnAppQuit` queda desactivado y la aplicación llama explícitamente a `quitAndInstall()` sólo cuando el usuario confirma y no hay trabajo activo.

La decisión de reinicio debe ser idempotente: una sola actualización descargada no debe abrir varios diálogos ni provocar múltiples reinicios. Registrar versión actual, versión disponible, resultado y error sin guardar tokens ni URLs RTSP con credenciales.

## Otras formas posibles

| Alternativa                              | Ventajas                                                         | Costos/riesgos                                                                                                                                                 | Cuándo elegirla                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| GitHub Releases + NSIS actual            | Ya está conectado; poca infraestructura; actualización integrada | Release público/configuración GitHub; poca segmentación por cliente; requiere versionado disciplinado                                                          | Recomendado para el tamaño y estado actual del proyecto.                                        |
| Servidor genérico HTTPS (CDN/R2/hosting) | Control de canal, acceso, rollout y disponibilidad               | Hay que hospedar correctamente los instaladores y `latest.yml`, controlar permisos, TLS, caché y rollback; una URL pública no debe permitir alterar artefactos | Si las releases deben ser privadas, por canal o distribuidas de forma controlada.               |
| Entrega manual del instalador            | Fácil como plan de emergencia                                    | El usuario vuelve a descargar/ejecutar el instalador y hay más soporte manual                                                                                  | Sólo fallback si el updater falla o para instalaciones aisladas. No es la experiencia objetivo. |
| Gestor de paquetes del sistema           | Gobierno central en organizaciones que ya administran PCs        | No reemplaza necesariamente el flujo en la app; publicación y soporte por plataforma aparte                                                                    | Si los clubes despliegan software con Intune/winget u otra herramienta institucional.           |

## Compatibilidad de versiones: no copiar la API de la documentación futura

El lockfile resuelve `electron-updater` **6.8.9** y el proyecto usa `electron-builder` **26.15.3**. En esa combinación está disponible `autoInstallOnAppQuit` y el flujo explícito `quitAndInstall()`.

La documentación más reciente también describe `autoInstallEvent = "onNextLaunch"`, pero identifica esa capacidad como perteneciente a `electron-updater` 7 / `electron-builder` 27. No debe añadirse esa propiedad al código actual sin actualizar y validar ambas dependencias. Si más adelante se decide migrar a esa versión, `onNextLaunch` puede reducir el riesgo de que el instalador quede interrumpido durante un apagado/logoff de Windows; debe probarse especialmente con el tipo de instalación usado por los clubes.

Referencias oficiales: [auto-update de electron-builder](https://www.electron.build/docs/features/auto-update) y [API de electron-updater](https://www.jsdocs.io/package/electron-updater). El package-lock del proyecto registra `electron-updater` 6.8.9 en [package-lock.json](../desktop-app/package-lock.json#L4970-L4977).

## Riesgos que hay que cubrir antes de habilitarlo a todos

- **Grabación/subida activa:** el cierre de ventanas en Windows termina la app y detiene el scheduler; no hay una coordinación del updater con FFmpeg o R2. La actualización no debería interrumpir un partido ni dejar una subida incompleta.
- **Firma del instalador:** no se encontró una configuración explícita de firma Authenticode en el workflow leído. Verificar cómo se firman las releases reales y usar un certificado protegido como secreto de CI; mantener el mismo publisher esperado para validar upgrades.
- **Versiones/tag:** el tag y el `package.json` deben ser consistentes; no publicar dos artefactos distintos con la misma versión.
- **Canales de prueba:** probar primero una release de QA/pre-release o un feed separado. No distribuir una release de prueba sobre el canal estable.
- **Rollback:** mantener disponibles la release anterior y una manera documentada de volver a ella; una instalación nueva no debe borrar `userData`.
- **Plataformas:** el workflow observado publica Windows. Aunque hay scripts/configuración para otras plataformas, no se encontró un workflow de release equivalente para macOS/Linux.

## Criterios de aceptación

- Una instalación Windows existente se actualiza a la siguiente versión sin desinstalación manual.
- El usuario ve detección, descarga, error y disponibilidad para reiniciar.
- El usuario puede posponer la instalación; la actualización queda lista para después.
- No se fuerza reinicio ni instalación durante una grabación o subida activa.
- Después del upgrade se conserva la configuración local y el vault.
- El comportamiento se valida en una instalación NSIS real, no sólo en modo desarrollo.
