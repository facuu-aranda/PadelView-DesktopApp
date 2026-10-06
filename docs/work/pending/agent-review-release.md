# Instrucciones para agente: revisar cambios y completar changelog

## Objetivo

Revisar los cambios actuales de ViewPadel Desktop antes de publicar una nueva versión y completar `src/renderer/src/update-changelog.json` con un texto orientado al usuario final.

## Alcance

1. Revisar los cambios actuales del repositorio, especialmente:
   - flujo visual de actualización de la aplicación;
   - modal de nueva versión y acciones disponibles;
   - versión visible en Configuración;
   - mejoras de sincronización automática de la interfaz;
   - corrección de copia de enlaces;
   - correcciones de grabación, detención manual y subida de videos;
   - mejoras de diagnóstico y estabilidad de fuentes de video.
2. Ejecutar las verificaciones disponibles para Desktop:
   - `npm run typecheck`;
   - `npx prettier --check` sobre los archivos modificados;
   - `git diff --check`.
3. Revisar `src/renderer/src/update-changelog.json`.
4. Completar o corregir la entrada de la próxima versión.

## Reglas para el changelog

El changelog debe estar escrito para usuarios de clubes y operadores, no para desarrolladores.

Incluir sólo beneficios y cambios visibles, por ejemplo:

- estados de grabación y subidas más actualizados;
- mayor estabilidad al grabar desde cámaras o DVR/NVR;
- posibilidad de guardar una grabación parcial al detenerla manualmente;
- copia de enlaces más confiable;
- nuevas notificaciones visuales de actualización;
- mejoras generales de estabilidad.

No incluir:

- nombres de archivos;
- nombres de funciones;
- IPC;
- FFmpeg flags;
- detalles de MediaMTX;
- nombres de tablas o columnas;
- errores internos;
- información de infraestructura;
- credenciales, URLs privadas o datos de diagnóstico.

## Formato esperado

Mantener este formato:

```json
{
  "VERSION": {
    "title": "Título breve para usuarios",
    "items": ["Cambio visible o beneficio para el usuario."]
  },
  "default": {
    "title": "Novedades de ViewPadel",
    "items": ["Mejoras de estabilidad y rendimiento."]
  }
}
```

Usar la versión definida en `desktop-app/package.json` o la versión de release que indique la tarea. No inventar funcionalidades que no estén implementadas.

## Restricciones

- No modificar lógica de negocio salvo que una verificación revele un error de compilación directamente relacionado con estos cambios.
- No eliminar cambios del usuario.
- No incluir información técnica en el changelog.
- Si hay problemas preexistentes o cambios ajenos, documentarlos sin revertirlos.
- Al finalizar, informar qué archivos se revisaron, qué verificaciones pasaron y cuál fue el texto final del changelog.
