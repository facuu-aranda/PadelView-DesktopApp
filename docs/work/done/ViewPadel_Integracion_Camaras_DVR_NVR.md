# ViewPadel — Integración robusta de cámaras IP y DVR/NVR

> Documento de implementación para agente de desarrollo  
> Proyecto: **ViewPadel**  
> Objetivo: separar correctamente el flujo de cámaras IP simples del flujo DVR/NVR y construir una arquitectura robusta, extensible y mantenible para descubrir, enumerar, previsualizar y seleccionar canales de grabadores.

---

# 1. Contexto general

ViewPadel es una plataforma para clubes de pádel compuesta principalmente por:

- `PadelView-DesktopApp`
  - Electron
  - React
  - TypeScript
  - FFmpeg
  - Supabase
  - Cloudflare R2
  - almacenamiento local
- `PadelView-WebApp`
  - Astro SSR
  - Supabase
  - Cloudflare R2
  - Vercel

El flujo de grabación actual depende de que cada cancha tenga una fuente de video accesible mediante RTSP.

Actualmente:

- el flujo de **cámara IP simple** funciona correctamente;
- existe un scanner LAN que detecta hosts/puertos relacionados con RTSP;
- se han agregado intentos de soportar DVR/NVR dentro del mismo flujo;
- esos intentos no han logrado una experiencia robusta;
- existe `camera-probe.service.ts`, pero no está correctamente integrado;
- existe `camera-snapshot.service.ts`, también sin integración completa;
- existe `local-court.service.ts`, que debe tenerse en cuenta porque la arquitectura de canchas debe avanzar hacia almacenamiento local.

El objetivo de esta tarea NO es “agregar unas plantillas RTSP más”.

El objetivo es **rediseñar correctamente la arquitectura de fuentes de video**.

---

# 2. Problema a resolver

Actualmente se están mezclando dos conceptos distintos:

## Caso A — Cámara IP directa

La cámara:

- tiene IP propia;
- expone RTSP directamente;
- está accesible desde la LAN;
- puede detectarse escaneando hosts/puertos;
- puede previsualizarse directamente.

Ejemplo conceptual:

```text
PC ViewPadel
    |
    +---- 192.168.1.50 Cámara IP
             |
             +---- RTSP
```

## Caso B — Cámara gestionada por DVR/NVR

La cámara puede:

- no tener una IP accesible desde la LAN;
- ser analógica y no tener IP en absoluto;
- estar conectada detrás de un DVR;
- estar conectada a un NVR con red PoE interna;
- ser expuesta al exterior únicamente a través del grabador.

Ejemplo conceptual:

```text
PC ViewPadel
    |
    +---- 192.168.1.100 DVR/NVR
              |
              +---- Canal 1 -> Cancha 1
              +---- Canal 2 -> Cancha 2
              +---- Canal 3 -> Entrada
              +---- Canal 4 -> Cancha 3
```

ViewPadel no debe intentar “descubrir” esas cámaras como si fueran dispositivos IP independientes.

Debe conectarse al **grabador** y luego descubrir sus canales.

---

# 3. Objetivo funcional

Al crear o editar una cancha, el usuario debe elegir qué tipo de fuente de video utiliza:

```text
¿Cómo está conectada la cámara?

[ Cámara IP ]
Cámara conectada directamente a la red.

[ DVR / NVR ]
Cámara administrada por un grabador.
```

A partir de ese momento, ambos flujos deben quedar separados.

---

# 4. Resultado esperado

Al finalizar esta tarea, ViewPadel deberá soportar:

## Cámara IP directa

- mantener el flujo actual;
- buscar cámaras en LAN;
- seleccionar una cámara;
- previsualizarla;
- guardar la configuración;
- usarla para grabaciones.

## DVR/NVR

- ingresar o detectar el grabador;
- solicitar credenciales;
- intentar identificar fabricante;
- intentar obtener canales mediante ONVIF;
- usar adaptadores específicos de fabricante cuando corresponda;
- usar probing RTSP sólo como fallback;
- enumerar canales válidos;
- obtener snapshots o previews;
- seleccionar visualmente el canal correcto;
- vincular ese canal a una cancha;
- persistir la configuración localmente;
- usar el canal seleccionado para grabaciones automáticas y manuales.

---

# 5. Principios obligatorios de arquitectura

## 5.1 No mezclar cámara directa y DVR/NVR

Debe existir una separación explícita entre:

```text
DirectCamera
```

y:

```text
Recorder / DVR / NVR
```

No agregar más lógica DVR al scanner de cámaras directas.

---

## 5.2 No pedir al usuario una URL RTSP si podemos derivarla

El usuario normal no debería necesitar escribir:

```text
rtsp://usuario:contraseña@192.168.1.100/...
```

Para DVR/NVR debemos intentar obtener o construir la URL internamente.

El usuario debería necesitar, idealmente:

```text
IP / hostname
usuario
contraseña
```

Y sólo en casos avanzados:

```text
puerto HTTP
puerto RTSP
fabricante
cantidad máxima de canales
URL RTSP manual
```

---

## 5.3 El grabador es una entidad reutilizable

No guardar la misma configuración DVR dentro de cada cancha.

Crear una entidad local conceptual:

```ts
LocalRecorder
```

que pueda ser reutilizada por varias canchas.

Ejemplo:

```text
DVR Principal
├── Canal 1 -> Cancha 1
├── Canal 2 -> Cancha 2
├── Canal 3 -> Cancha 3
└── Canal 4 -> Cancha 4
```

---

# 6. Modelo de datos local propuesto

Adaptar nombres finales al código real del proyecto.

## 6.1 LocalRecorder

Ejemplo:

```ts
type RecorderVendor =
  | 'hikvision'
  | 'dahua'
  | 'generic'
  | 'unknown'

type LocalRecorder = {
  id: string
  name: string

  host: string

  httpPort?: number
  httpsPort?: number
  rtspPort: number

  vendor: RecorderVendor
  model?: string
  serialNumber?: string

  onvifSupported?: boolean

  createdAt: string
  updatedAt: string
}
```

NO guardar contraseña dentro de este objeto.

---

## 6.2 Credenciales

Guardar credenciales sensibles mediante `vault.service.ts` o mecanismo local seguro equivalente.

Ejemplo conceptual:

```text
RECORDER_{recorderId}_USERNAME
RECORDER_{recorderId}_PASSWORD
```

No imprimir valores en logs.

No duplicar credenciales en varios stores.

---

## 6.3 VideoSource

Una cancha debe poder referenciar diferentes tipos de fuente.

Ejemplo:

```ts
type DirectCameraSource = {
  type: 'direct-camera'
  rtspKey: string
}

type RecorderSource = {
  type: 'recorder'
  recorderId: string
  channelId: string
  channelNumber?: number
  stream: 'main' | 'sub'
}

type VideoSource =
  | DirectCameraSource
  | RecorderSource
```

---

## 6.4 LocalCourt

Ejemplo conceptual:

```ts
type LocalCourt = {
  id: string
  name: string
  videoSource: VideoSource
  createdAt: string
  updatedAt: string
}
```

La implementación debe respetar la decisión arquitectónica de mantener canchas localmente.

---

# 7. UX — nuevo modal intermedio

Al pulsar:

```text
Registrar cancha
```

antes del flujo actual de selección de cámara, mostrar un modal intermedio.

## Diseño conceptual

```text
┌───────────────────────────────────────────────┐
│ ¿Cómo está conectada la cámara?              │
│                                               │
│ ┌──────────────────┐ ┌─────────────────────┐ │
│ │ Cámara IP        │ │ DVR / NVR           │ │
│ │                  │ │                     │ │
│ │ Cámara conectada │ │ Cámara conectada a  │ │
│ │ directamente a   │ │ un grabador.        │ │
│ │ la red local.    │ │                     │ │
│ │                  │ │                     │ │
│ │ [ Continuar ]    │ │ [ Continuar ]       │ │
│ └──────────────────┘ └─────────────────────┘ │
│                                               │
│                       [ Cancelar ]            │
└───────────────────────────────────────────────┘
```

---

# 8. Flujo Cámara IP

La opción:

```text
Cámara IP
```

debe conservar el flujo que actualmente funciona.

No reescribir innecesariamente.

Flujo:

```text
Agregar cancha
    ↓
Cámara IP
    ↓
Buscar dispositivos
    ↓
Scanner LAN existente
    ↓
Seleccionar cámara
    ↓
Preview
    ↓
Guardar
```

---

# 9. Purga del flujo Cámara IP

Revisar el código actual y eliminar del flujo directo toda lógica añadida exclusivamente para soportar DVR.

Buscar:

```bash
rg "DVR"
rg "NVR"
rg "channel"
rg "probe"
rg "Streaming/Channels"
rg "realmonitor"
rg "ISAPI"
```

No eliminar automáticamente.

Analizar cada referencia.

El flujo de cámara directa debe volver a tener una responsabilidad pequeña y clara:

> localizar y validar cámaras IP directamente accesibles.

---

# 10. Flujo DVR/NVR — UX

Al elegir:

```text
DVR / NVR
```

mostrar una pantalla/modal específica.

Primera pantalla:

```text
Conectar DVR / NVR
```

Opciones:

```text
[ Buscar grabadores en mi red ]

o

Dirección / IP:
[ 192.168.1.100 ]

Usuario:
[ admin ]

Contraseña:
[ ******** ]

[ Opciones avanzadas ]

[ Conectar ]
```

---

# 11. Opciones avanzadas

Ocultas por defecto.

Pueden incluir:

```text
Fabricante
[ Detectar automáticamente ]

Puerto HTTP
[ 80 ]

Puerto HTTPS
[ 443 ]

Puerto RTSP
[ 554 ]

Cantidad máxima de canales
[ Detectar automáticamente ]

[ URL RTSP manual / configuración avanzada ]
```

No obligar al usuario a completar esto salvo necesidad.

---

# 12. Reutilización de grabadores existentes

Si ya existen grabadores configurados:

```text
Grabadores configurados

DVR Principal
192.168.1.100
Hikvision
8 canales detectados

[ Usar este grabador ]

DVR Sector 2
192.168.1.120
Dahua
4 canales detectados

[ Usar este grabador ]

[ + Conectar nuevo DVR / NVR ]
```

Una vez elegido un grabador existente, ir directamente a selección de canal.

---

# 13. Arquitectura objetivo de servicios

Crear o refactorizar hacia una estructura equivalente a:

```text
src/main/services/video-sources/

  direct-camera.service.ts

  recorder/
    recorder.service.ts
    recorder-store.service.ts
    recorder-discovery.service.ts
    recorder-probe.service.ts
    recorder-snapshot.service.ts

    adapters/
      recorder-adapter.ts
      onvif.adapter.ts
      hikvision.adapter.ts
      dahua.adapter.ts
      generic-rtsp.adapter.ts
```

No es obligatorio respetar exactamente estas rutas si el repositorio tiene una convención mejor.

Sí es obligatorio respetar la separación de responsabilidades.

---

# 14. Interfaz RecorderAdapter

Crear una abstracción común.

Ejemplo conceptual:

```ts
interface RecorderAdapter {
  detectDevice(): Promise<RecorderDeviceInfo>

  authenticate(): Promise<boolean>

  getChannels(): Promise<RecorderChannel[]>

  getStreamUri(
    channel: RecorderChannel,
    stream: 'main' | 'sub'
  ): Promise<string>

  getSnapshot?(
    channel: RecorderChannel
  ): Promise<Buffer | null>
}
```

---

# 15. RecorderDeviceInfo

Ejemplo:

```ts
type RecorderDeviceInfo = {
  vendor: RecorderVendor
  model?: string
  serialNumber?: string
  firmware?: string
  onvifSupported?: boolean
}
```

---

# 16. RecorderChannel

Ejemplo:

```ts
type RecorderChannel = {
  id: string
  number?: number
  name?: string

  enabled: boolean

  mainStreamAvailable?: boolean
  subStreamAvailable?: boolean

  snapshotAvailable?: boolean
}
```

No asumir siempre que los canales son `1..N`.

Permitir identificadores opacos cuando el fabricante lo requiera.

---

# 17. Estrategia de detección

La detección debe seguir una jerarquía.

```text
1. ONVIF
      ↓ falla o incompleto
2. Adapter específico del fabricante
      ↓ falla
3. RTSP probing por plantillas conocidas
      ↓ falla
4. Configuración manual avanzada
```

No invertir este orden.

---

# 18. Nivel 1 — ONVIF

Intentar primero ONVIF porque permite una integración más genérica.

Implementar:

- detección/discovery cuando sea viable;
- autenticación;
- lectura de información del dispositivo;
- enumeración de perfiles;
- obtención de streams;
- asociación perfil/canal.

Operaciones conceptuales relevantes:

```text
GetDeviceInformation
GetVideoSources
GetProfiles
GetStreamUri
```

Adaptar al paquete/librería ONVIF elegida.

---

# 19. Discovery ONVIF

Agregar un discovery específico para grabadores/dispositivos ONVIF.

NO reutilizar el scanner TCP actual como si fuera equivalente.

El discovery ONVIF puede complementarse con:

```text
WS-Discovery
```

El flujo puede ser:

```text
Buscar DVR/NVR
    ↓
WS-Discovery
    ↓
Lista de dispositivos
    ↓
usuario selecciona uno
    ↓
credenciales
    ↓
identificación
```

Si multicast/WS-Discovery no funciona en la red, ofrecer IP manual.

---

# 20. No depender de ONVIF

ONVIF puede:

- estar deshabilitado;
- necesitar un usuario específico;
- estar parcialmente implementado;
- no devolver canales de manera útil;
- devolver perfiles duplicados;
- no identificar correctamente main/substream.

Por eso debe ser sólo el primer nivel.

---

# 21. Nivel 2 — fabricante

Agregar adaptadores específicos inicialmente para:

```text
Hikvision
Dahua
```

No intentar soportar todos los fabricantes en esta primera tarea.

Dejar preparada la arquitectura para agregar:

```text
Uniview
Reolink
TVT
XMEye
etc.
```

sin modificar el resto del sistema.

---

# 22. HikvisionAdapter

Debe intentar aprovechar APIs/protocolos oficiales disponibles en el dispositivo.

Objetivos:

- identificar dispositivo;
- verificar credenciales;
- consultar canales;
- obtener nombres de canales si existen;
- obtener información suficiente para construir streams;
- obtener snapshot si existe endpoint compatible.

Debe soportar fallback a RTSP conocido.

Ejemplo conceptual habitual de canales:

```text
101 -> Canal 1 main
102 -> Canal 1 sub
201 -> Canal 2 main
202 -> Canal 2 sub
...
```

NO asumir este formato como universal sin validación.

---

# 23. DahuaAdapter

Objetivos equivalentes:

- identificación;
- autenticación;
- canales;
- nombres;
- streams;
- snapshots si son posibles.

Fallback RTSP conceptual:

```text
channel=1&subtype=0
channel=1&subtype=1
channel=2&subtype=0
channel=2&subtype=1
```

donde normalmente:

```text
subtype=0 -> main
subtype=1 -> sub
```

Validar siempre el stream antes de mostrarlo como disponible.

---

# 24. Nivel 3 — RTSP probing

Reutilizar/refactorizar:

```text
camera-probe.service.ts
```

como:

```text
recorder-probe.service.ts
```

o responsabilidad equivalente.

Este servicio NO debe intentar descubrir absolutamente todo.

Debe recibir contexto:

```ts
{
  vendor,
  host,
  rtspPort,
  credentials,
  possibleChannels
}
```

y probar únicamente templates relevantes.

---

# 25. Prohibido hacer brute force masivo

No probar cientos/miles de combinaciones indiscriminadamente.

Problemas:

- demasiadas conexiones;
- bloqueo temporal del DVR;
- alto consumo de red;
- mala UX;
- lentitud;
- falsos negativos;
- riesgo de activar protecciones anti-fuerza-bruta.

Implementar:

- límites de concurrencia;
- timeouts cortos;
- cancelación;
- progreso;
- templates por fabricante.

---

# 26. Concurrencia de probing

Limitar a aproximadamente:

```text
2-4 probes simultáneos
```

Elegir valor final según pruebas.

No abrir 16/32/64 streams simultáneamente.

---

# 27. Timeout de probes

Cada prueba debe:

- abrir conexión;
- validar que existe stream de video;
- cerrar inmediatamente;
- no comenzar una grabación larga.

Preferentemente usar `ffprobe` si está disponible.

Si no, usar FFmpeg con una ejecución muy corta.

---

# 28. Validación real del stream

No considerar un canal válido solamente porque:

```text
TCP 554 está abierto
```

Se debe verificar que:

- autenticación sea válida;
- el endpoint RTSP responda;
- exista una pista de video;
- el stream sea consumible.

---

# 29. Cantidad de canales

Prioridad:

```text
1. obtener canales mediante ONVIF/API
2. obtener capacidad declarada por el dispositivo
3. solicitar máximo al usuario
4. fallback controlado
```

No inferir:

```text
falló canal 4 => no existen canales mayores
```

Puede haber canales deshabilitados/intermedios.

---

# 30. UX para cantidad de canales

Dentro de opciones avanzadas:

```text
Cantidad máxima de canales

[ Detectar automáticamente ]

○ 4
○ 8
○ 16
○ 32
○ 64
○ Otro
```

Si la búsqueda automática sólo probó hasta 16:

```text
¿No encontrás tu cámara?

[ Buscar hasta 32 canales ]
[ Buscar hasta 64 canales ]
```

---

# 31. Resultado de descubrimiento

Después de detectar canales mostrar una galería.

Ejemplo:

```text
Seleccioná la cámara de esta cancha

┌─────────────────┐
│   snapshot      │
│                 │
│ Canal 1         │
│ Principal       │
│ [ Preview ]     │
└─────────────────┘

┌─────────────────┐
│   snapshot      │
│                 │
│ Canal 2         │
│ Principal       │
│ [ Preview ]     │
└─────────────────┘
```

---

# 32. Snapshots

Preferir snapshots estáticos para la grilla.

No abrir preview live de todos los canales simultáneamente.

Prioridad para snapshot:

```text
1. endpoint snapshot del fabricante
2. ONVIF snapshot si está disponible
3. capturar un frame mediante FFmpeg
```

---

# 33. camera-snapshot.service.ts

Revisar el servicio existente.

No asumir que su implementación actual es correcta.

Puede:

- reutilizarse;
- dividirse por adapters;
- convertirse en fallback;
- eliminarse si la arquitectura nueva lo reemplaza.

Si contiene lógica exclusivamente Hikvision, moverla a:

```text
hikvision.adapter.ts
```

o un servicio claramente asociado a Hikvision.

---

# 34. Preview

Al seleccionar:

```text
Preview
```

abrir únicamente el stream elegido.

Para preview preferir:

```text
substream
```

cuando esté disponible.

Para grabación preferir:

```text
main stream
```

---

# 35. Separar preview y grabación

Una cancha vinculada a DVR debería poder almacenar conceptualmente:

```text
channel
main stream
sub stream
```

No guardar necesariamente las URLs completas.

Idealmente derivarlas en runtime desde:

```text
recorder
+
channel
+
adapter
```

---

# 36. Resolver stream en runtime

Crear una función central equivalente a:

```ts
resolveVideoSource(courtId)
```

Resultado:

```ts
{
  recordingUrl: string
  previewUrl?: string
}
```

La UI, scheduler y FFmpeg no deberían conocer detalles Hikvision/Dahua.

---

# 37. Scheduler

El scheduler debe pedir una fuente ya resuelta.

Flujo objetivo:

```text
match
   ↓
localCourt
   ↓
videoSource
   ↓
VideoSourceResolver
   ↓
RTSP final
   ↓
FFmpeg
```

NO agregar condicionales de fabricante dentro de:

```text
scheduler.service.ts
```

Ejemplo prohibido:

```ts
if (court.vendor === 'hikvision') {
  ...
} else if (court.vendor === 'dahua') {
  ...
}
```

Eso debe vivir en adapters/resolvers.

---

# 38. FFmpeg

Mantener el flujo actual siempre que sea compatible:

```text
RTSP
 ↓
FFmpeg
 ↓
-c copy
 ↓
MP4
```

No recodificar sin necesidad.

---

# 39. Grabación automática

Debe funcionar igual independientemente de si la fuente es:

```text
camera direct
```

o:

```text
recorder channel
```

El scheduler sólo debe recibir una URL RTSP válida.

---

# 40. Grabación manual

Debe utilizar el mismo resolver.

No duplicar lógica.

---

# 41. Persistencia local

Toda la configuración física debe permanecer local:

```text
canchas
grabadores
IPs
puertos
credenciales
RTSP
canales
```

No enviar infraestructura del club a Supabase salvo información histórica estrictamente necesaria para `matches`.

---

# 42. Seguridad de credenciales

Nunca almacenar:

```text
username
password
```

en:

- Supabase;
- logs;
- metadata de match;
- URLs visibles en UI;
- excepciones enviadas a servicios externos.

Usar vault local.

---

# 43. URLs con credenciales

Evitar persistir URLs completas como:

```text
rtsp://admin:password@192.168.1.100/...
```

si pueden reconstruirse.

Si temporalmente se construyen:

- mantenerlas en memoria;
- sanitizar logs;
- nunca enviarlas al renderer si no es necesario.

---

# 44. Sanitización de logs

Agregar helper central para sanitizar:

```text
rtsp://user:password@host/path
```

como:

```text
rtsp://***:***@host/path
```

Idealmente no loggear la URL completa.

---

# 45. IPC

Definir IPC específico y coherente.

Ejemplo conceptual:

```text
recorders:list
recorders:discover
recorders:create
recorders:update
recorders:delete

recorders:test-connection
recorders:detect-device
recorders:list-channels
recorders:get-snapshot
recorders:test-channel

video-source:preview-start
video-source:preview-stop
```

Adaptar naming a la convención real.

---

# 46. Progreso de búsqueda

El usuario debe recibir feedback.

Ejemplo:

```text
Conectando al grabador...
Identificando fabricante...
Intentando ONVIF...
Consultando canales...
Probando streams...
Generando previews...
```

No dejar un spinner indefinido sin explicación.

---

# 47. Cancelación

Toda búsqueda/probing debe poder cancelarse.

Botón:

```text
Cancelar búsqueda
```

Debe:

- abortar probes;
- cerrar FFmpeg/ffprobe;
- detener requests;
- liberar listeners.

---

# 48. Timeouts

Todas las comunicaciones externas deben tener timeout.

Incluye:

```text
HTTP
HTTPS
ONVIF
RTSP probe
snapshot
FFmpeg
ffprobe
```

Nunca esperar indefinidamente.

---

# 49. Manejo de autenticación incorrecta

Si el host existe pero las credenciales fallan:

mostrar un error específico.

Ejemplo:

```text
No pudimos autenticar en el DVR/NVR.

Verificá el usuario y la contraseña.
```

No confundir con:

```text
No encontramos el dispositivo.
```

---

# 50. Manejo de ONVIF deshabilitado

Si ONVIF falla:

NO mostrar error definitivo.

Continuar con:

```text
adapter específico
```

y luego:

```text
RTSP probing
```

---

# 51. Detección de fabricante

Intentar mediante:

```text
ONVIF DeviceInformation
HTTP headers
endpoints conocidos
respuesta API
metadata del dispositivo
```

No basarse únicamente en puertos.

---

# 52. Fabricante desconocido

Si no se identifica:

```text
Fabricante: Desconocido
```

usar:

```text
generic-rtsp.adapter
```

y ofrecer configuración manual.

---

# 53. Modo manual avanzado

Debe existir como último fallback.

Ejemplo:

```text
Configurar canal manualmente

URL RTSP:
[ ... ]

[ Probar stream ]

[ Preview ]

[ Usar esta cámara ]
```

Este modo es para integraciones raras.

No debe ser el flujo principal.

---

# 54. No bloquear el producto por dispositivos raros

Si un DVR no puede ser autodetectado pero el usuario conoce una URL RTSP válida, debe poder configurar la cancha.

Por lo tanto:

```text
manual RTSP
```

es un fallback obligatorio.

---

# 55. Grabadores con red interna PoE

No asumir que las cámaras conectadas a un NVR son accesibles directamente desde la LAN.

Ejemplo:

```text
NVR 192.168.1.100

red PoE interna:
10.0.0.2
10.0.0.3
10.0.0.4
```

ViewPadel debe poder trabajar únicamente con:

```text
NVR 192.168.1.100
+
channel
```

sin acceso a esas IP internas.

---

# 56. Cámaras analógicas

Una cámara analógica conectada a DVR puede no tener:

```text
IP
ONVIF
RTSP propio
```

No tratar de descubrirla individualmente.

Sólo existe como canal del DVR.

---

# 57. Historial de grabadores

Persistir:

```text
lastSuccessfulConnectionAt
lastDetectedVendor
lastDetectedModel
```

si resulta útil.

No guardar secretos en esos campos.

---

# 58. Estado de grabador

Puede resultar útil manejar:

```text
connected
unreachable
auth-failed
partial
unknown
```

pero no complicar innecesariamente la primera implementación.

---

# 59. Eliminación de grabador

No permitir eliminar un grabador si existen canchas que lo utilizan.

Mostrar:

```text
Este DVR/NVR está siendo utilizado por 4 canchas.

Reasigná o eliminá esas canchas antes de eliminar el grabador.
```

---

# 60. Edición de grabador

Al cambiar:

```text
host
puerto
usuario
contraseña
```

las canchas vinculadas deben seguir apuntando al mismo:

```text
recorderId
```

No duplicar configuración.

---

# 61. Cambio de contraseña

Actualizar el vault.

Luego ofrecer:

```text
[ Probar conexión ]
```

---

# 62. Cambio de IP

Al modificar host/IP:

- actualizar sólo el grabador;
- validar conexión;
- no modificar cada cancha manualmente.

---

# 63. Canales desaparecidos

Si una cancha referencia:

```text
channel 5
```

pero el DVR ya no lo expone:

no eliminar la cancha.

Marcar la fuente como:

```text
no disponible
```

y mostrar una acción:

```text
Reconfigurar fuente de video
```

---

# 64. Canal reconfigurado

Si el DVR cambia qué cámara física corresponde a un canal, ViewPadel no puede saberlo automáticamente.

Permitir:

```text
Revisar preview
Reasignar canal
```

---

# 65. Integración con LocalCourtService

La cancha debe guardar sólo referencia necesaria.

Ejemplo:

```ts
videoSource: {
  type: 'recorder',
  recorderId: '...',
  channelId: '...',
  stream: 'main'
}
```

No guardar:

```text
host
username
password
vendor
```

duplicados dentro de la cancha.

---

# 66. Migración del código existente

Revisar:

```text
camera-probe.service.ts
camera-snapshot.service.ts
local-court.service.ts
discovery.service.ts
CameraScannerModal.tsx
App.tsx
index.ts
preload
scheduler.service.ts
ffmpeg.service.ts
vault.service.ts
```

Buscar también referencias indirectas.

---

# 67. No destruir lógica funcional

La cámara directa actualmente funciona.

No reescribirla completamente si no es necesario.

Refactorizar sólo lo requerido para separar responsabilidades.

---

# 68. App.tsx

`App.tsx` ya es monolítico.

No agregar toda la nueva lógica DVR directamente dentro del componente.

Extraer componentes/hooks donde corresponda.

Ejemplo conceptual:

```text
components/video-source/
  VideoSourceTypeModal.tsx
  DirectCameraFlow.tsx
  RecorderSetupModal.tsx
  RecorderDiscoveryModal.tsx
  RecorderChannelsModal.tsx
  RecorderChannelCard.tsx
```

Adaptar a la estructura actual.

---

# 69. Estado del wizard DVR

Manejar estados explícitos:

```text
idle
discovering
awaiting-credentials
connecting
detecting
loading-channels
loading-previews
ready
error
cancelled
```

Evitar múltiples booleanos ambiguos.

---

# 70. Máquina de estados conceptual del flujo

```text
START
  |
  v
SELECT_SOURCE_TYPE
  |
  +---- DIRECT_CAMERA
  |
  +---- RECORDER
           |
           v
    SELECT_OR_CREATE_RECORDER
           |
           v
       CONNECTING
           |
           v
      DETECT_DEVICE
           |
           v
     LOAD_CHANNELS
           |
           v
     SELECT_CHANNEL
           |
           v
        PREVIEW
           |
           v
         SAVE
```

---

# 71. Error recovery en wizard

Ante fallo:

```text
[ Reintentar ]
[ Editar conexión ]
[ Configuración manual ]
[ Cancelar ]
```

No obligar a comenzar desde cero.

---

# 72. Tests unitarios — adapters

Agregar tests para:

```text
HikvisionAdapter
DahuaAdapter
GenericRtspAdapter
```

Mockear red cuando sea posible.

Probar:

- construcción de URLs;
- mapeo de canales;
- detección de streams;
- sanitización;
- errores de autenticación.

---

# 73. Tests — resolver

Probar:

```text
LocalCourt
 -> recorder
 -> channel
 -> resolved RTSP
```

---

# 74. Tests — seguridad

Asegurarse de que:

```text
password
RTSP credentials
```

no aparezcan en logs generados durante tests.

---

# 75. Tests — eliminación

Probar:

```text
recorder utilizado por cancha
```

Debe rechazarse su eliminación.

---

# 76. Tests — edición

Probar:

```text
editar IP del recorder
```

No debe cambiar:

```text
recorderId
```

ni romper relaciones con canchas.

---

# 77. Tests — fallback

Simular:

```text
ONVIF falla
vendor adapter funciona
```

y:

```text
ONVIF falla
vendor adapter falla
RTSP probe funciona
```

---

# 78. Tests — cancelación

Asegurarse de cancelar:

- probes;
- requests;
- procesos FFmpeg;
- listeners.

---

# 79. Prueba manual — cámara directa

Caso obligatorio:

```text
Agregar cancha
→ Cámara IP
→ buscar
→ seleccionar
→ preview
→ guardar
→ reiniciar
→ preview
→ grabar
```

Debe seguir funcionando igual que antes.

---

# 80. Prueba manual — DVR Hikvision

```text
Agregar cancha
→ DVR/NVR
→ ingresar DVR
→ credenciales
→ detectar
→ enumerar canales
→ snapshots
→ seleccionar canal
→ preview
→ guardar
→ grabar
```

---

# 81. Prueba manual — DVR Dahua

Mismo flujo.

---

# 82. Prueba manual — ONVIF

Validar dispositivo compatible sin depender de adapter específico.

---

# 83. Prueba manual — ONVIF deshabilitado

El flujo debe continuar con adapter/fallback.

---

# 84. Prueba manual — credenciales incorrectas

Debe mostrar error claro.

No bloquear la UI.

---

# 85. Prueba manual — host inexistente

Debe finalizar por timeout razonable.

---

# 86. Prueba manual — canal inválido

No mostrarlo como canal válido.

---

# 87. Prueba manual — snapshot no disponible

El canal debe seguir siendo utilizable.

Mostrar placeholder:

```text
Vista previa no disponible
```

y permitir:

```text
Probar stream
```

---

# 88. Prueba manual — substream no disponible

Usar main stream para preview si es necesario.

No bloquear selección.

---

# 89. Prueba manual — main stream no disponible

No permitir configurar como fuente de grabación sin advertir claramente.

---

# 90. Rendimiento

No generar automáticamente previews live para todos los canales.

Preferir:

```text
snapshot
```

y sólo abrir live stream al solicitarlo.

---

# 91. Cache de detección

Puede cachearse temporalmente:

```text
deviceInfo
channels
```

para evitar repetir consultas en el mismo wizard.

No cachear contraseñas fuera del vault.

---

# 92. Logs técnicos

Agregar logs útiles pero sanitizados:

```text
Recorder detected: hikvision
Channels discovered: 8
Channel 3 stream validation: success
ONVIF unavailable, falling back to vendor adapter
```

Nunca:

```text
password=...
rtsp://user:pass@...
```

---

# 93. Errores amigables

Mapear errores técnicos a mensajes:

```text
ECONNREFUSED
```

→

```text
No pudimos conectarnos con el grabador.
```

```text
401
```

→

```text
Usuario o contraseña incorrectos.
```

```text
timeout
```

→

```text
El grabador no respondió a tiempo.
```

---

# 94. Telemetría opcional

No enviar:

- IP privada;
- credenciales;
- RTSP;
- serial;
- topología de red.

Si existe analytics, registrar sólo eventos genéricos.

---

# 95. Compatibilidad con actualización

La nueva persistencia local debe sobrevivir:

- reinicios;
- auto-update;
- cambio de versión;
- cierre inesperado.

---

# 96. No depender de internet

Configurar cámaras/DVR dentro de la LAN debe poder funcionar sin acceso externo a internet, salvo las partes de ViewPadel que realmente dependan de servicios cloud.

---

# 97. Prioridades de implementación

Implementar en este orden.

## Fase 1 — separación

- modal tipo de fuente;
- restaurar flujo simple de cámara IP;
- aislar lógica DVR;
- modelos `VideoSource` y `LocalRecorder`.

## Fase 2 — infraestructura recorder

- storage local;
- vault;
- IPC;
- RecorderService;
- adapters interface;
- resolver.

## Fase 3 — ONVIF

- discovery;
- autenticación;
- información;
- perfiles;
- stream URIs.

## Fase 4 — Hikvision

- identificación;
- canales;
- main/sub;
- snapshots;
- fallback RTSP.

## Fase 5 — Dahua

Misma cobertura.

## Fase 6 — generic RTSP probe

- plantillas;
- límites;
- cancelación;
- timeouts.

## Fase 7 — UX de canales

- cards;
- snapshots;
- preview;
- selección;
- guardar.

## Fase 8 — scheduler

- VideoSourceResolver;
- grabación manual;
- automática;
- recovery.

## Fase 9 — tests y limpieza

- tests;
- logs;
- dead code;
- documentación.

---

# 98. Criterios de aceptación generales

La tarea no está terminada hasta cumplir TODOS.

## Arquitectura

- Cámara IP y DVR/NVR tienen flujos separados.
- DVR/NVR no depende del scanner de cámara directa.
- Existe abstracción de recorder.
- Existe abstraction/adapters para fabricantes.
- El scheduler no conoce fabricantes.
- FFmpeg recibe una URL resuelta.

## Cámara IP

- Sigue funcionando.
- Search funciona.
- Preview funciona.
- Guardado funciona.
- Grabación funciona.

## DVR/NVR

- Puede configurarse por IP.
- Puede autenticarse.
- Intenta ONVIF.
- Tiene fallback por fabricante.
- Tiene fallback RTSP.
- Puede enumerar canales.
- Puede mostrar snapshot/preview.
- Puede seleccionar un canal.
- Puede reutilizar un DVR en varias canchas.
- Puede editarse un DVR sin editar cada cancha.

## Seguridad

- Credenciales sólo locales.
- No se exponen en logs.
- No se guardan en Supabase.
- No se duplican innecesariamente.
- RTSP sensible se sanitiza.

## Grabación

- Manual funciona.
- Automática funciona.
- Scheduler funciona.
- Recovery sigue funcionando.

## UX

- Existe modal intermedio.
- Existe wizard DVR/NVR.
- Hay progreso.
- Hay cancelación.
- Hay errores claros.
- Existe fallback manual.

---

# 99. Criterios de aceptación específicos de rendimiento

- No abrir previews live simultáneos de todos los canales.
- Probing con concurrencia limitada.
- Timeouts en requests.
- Procesos correctamente cerrados.
- Sin memory leaks obvios.
- Sin listeners duplicados.

---

# 100. Criterios de aceptación específicos de mantenibilidad

No dejar:

```ts
if (vendor === 'hikvision')
```

repetidos por todo el código.

La lógica específica debe estar encapsulada.

Agregar un nuevo fabricante debería requerir principalmente:

```text
nuevo adapter
+
registro del adapter
```

y no reescribir scheduler/UI/FFmpeg.

---

# 101. Investigación previa obligatoria

Antes de implementar:

1. leer `Docs/ViewPadel-Context-Fusion.md`;
2. leer `AGENTS.md`;
3. leer `CLAUDE.md` si existe;
4. revisar `git status`;
5. revisar `git diff`;
6. revisar rama;
7. inspeccionar servicios existentes;
8. identificar código DVR experimental;
9. identificar flujo cámara simple estable;
10. documentar la estrategia antes de tocar grandes áreas.

---

# 102. Búsquedas recomendadas

```bash
rg "camera-probe"
rg "camera-snapshot"
rg "DiscoveryService"
rg "CameraScannerModal"
rg "rtsp"
rg "RTSP"
rg "DVR"
rg "NVR"
rg "ONVIF"
rg "Streaming/Channels"
rg "realmonitor"
rg "channel"
rg "stream:start"
rg "stream:stop"
rg "scheduler"
```

---

# 103. No tocar secretos

No abrir/imprimir valores de:

```text
.env
tokens
R2 credentials
Supabase service role
RTSP credentials
```

Si se detectan secretos trackeados, no copiarlos.

Documentar solamente que existe el riesgo.

---

# 104. Compatibilidad con la decisión de canchas locales

Este trabajo debe respetar:

```text
Canchas -> local
Grabadores -> local
RTSP -> local/vault
Matches -> Supabase
Videos -> R2
```

No introducir una dependencia nueva de Supabase para DVR/NVR.

---

# 105. Cambios en documentación

Actualizar:

```text
Docs/ViewPadel-Context-Fusion.md
```

incluyendo:

- nueva arquitectura de fuentes;
- flujo cámara directa;
- flujo DVR/NVR;
- nuevos servicios;
- nuevos IPC;
- almacenamiento local;
- modelos;
- adapters;
- riesgos;
- verificaciones;
- funcionalidades implementadas/parciales.

---

# 106. Verificaciones técnicas

Ejecutar como mínimo en Desktop:

```bash
npm.cmd run typecheck
npm.cmd run build
```

También:

```bash
npm.cmd run lint
```

si corresponde.

Si lint falla por errores preexistentes:

- diferenciar fallos existentes;
- verificar que no se agregaron errores nuevos.

Ejecutar tests nuevos.

---

# 107. Verificación del diff

Antes de commit:

```bash
git diff
git status
```

Revisar manualmente:

- código muerto;
- secretos;
- logs;
- imports;
- errores;
- duplicación;
- paths.

---

# 108. Rama obligatoria

Trabajar exclusivamente en:

```text
luna-develop
```

Comprobar:

```bash
git branch --show-current
```

Si no está en `luna-develop`, seguir las reglas documentadas en el contexto del proyecto.

---

# 109. No destruir cambios ajenos

No utilizar silenciosamente:

```text
git reset
git clean
git restore
git stash
```

No descartar archivos sin revisar.

---

# 110. Secuencia Git de entrega

Al finalizar:

```bash
git add <solo archivos de esta tarea>
git diff --cached --check
git diff --cached
git commit -m "feat: add recorder camera source support"
git push -u origin luna-develop
git branch --show-current
git status
git log -1 --oneline
```

No usar:

```text
git add .
git add -A
git pull
merge
rebase
PR automático
```

---

# 111. Reporte final obligatorio del agente

Al terminar informar:

1. arquitectura final;
2. archivos creados;
3. archivos modificados;
4. flujo cámara IP;
5. flujo DVR/NVR;
6. implementación ONVIF;
7. implementación Hikvision;
8. implementación Dahua;
9. implementación generic RTSP;
10. persistencia LocalRecorder;
11. manejo de credenciales;
12. resolver de VideoSource;
13. integración scheduler;
14. integración preview;
15. pruebas manuales realizadas;
16. tests automatizados agregados;
17. resultados typecheck/build/lint/tests;
18. deuda técnica restante;
19. dispositivos/fabricantes no cubiertos;
20. rama;
21. commit;
22. confirmación de push.

---

# 112. Definición final de éxito

El resultado ideal debe permitir que un instalador llegue a un club y haga:

```text
Abrir ViewPadel

→ Registrar Cancha

→ DVR/NVR

→ Buscar dispositivo

→ seleccionar "DVR Principal"

→ ingresar usuario y contraseña

→ ViewPadel detecta Hikvision

→ detecta 8 canales

→ muestra thumbnails

→ instalador reconoce visualmente Cancha 1

→ selecciona Canal 3

→ abre preview

→ confirma

→ guarda
```

Después:

```text
agenda un partido
```

y ViewPadel automáticamente:

```text
match
→ localCourt
→ recorderId
→ channelId
→ adapter
→ main RTSP
→ FFmpeg
→ MP4
→ R2
→ DONE
```

Sin que el usuario haya tenido que conocer:

```text
una URL RTSP
un path Hikvision
un channel code
un endpoint Dahua
ONVIF
FFmpeg
```

---

# 113. Principio rector

La integración debe optimizarse para:

```text
"El usuario sabe qué DVR tiene y qué cámara ve la cancha,
pero no debería saber cómo construir una URL RTSP."
```

ViewPadel debe absorber esa complejidad.

---

# 114. No declarar finalizada la tarea antes de tiempo

La tarea sólo se considera completa cuando:

- la cámara IP sigue funcionando;
- un DVR/NVR puede configurarse;
- los canales pueden descubrirse o configurarse mediante fallback;
- un canal puede previsualizarse;
- una cancha puede guardar esa referencia;
- el scheduler puede resolverla;
- FFmpeg puede grabarla;
- los secretos permanecen locales;
- la arquitectura queda documentada;
- typecheck/build pasan;
- el diff fue revisado;
- commit y push se realizaron en `luna-develop`.
