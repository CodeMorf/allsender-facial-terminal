# AllSender Facial: operación online y offline

Este documento describe la extensión offline del terminal facial. El flujo
online existente continúa siendo la autoridad de la nube; la parte offline
solo puede activarse cuando la terminal vinculada tenga el motor local SFace
compatible y una copia cifrada de las plantillas de su sucursal.

## Flujo actual preservado

1. La terminal se vincula con GPS y PIN temporal.
2. `GET /api/v1/facial/terminals/config` entrega la sucursal, modo, horario,
   batería y políticas actuales.
3. MediaPipe detecta que hay exactamente un rostro frente a la cámara.
4. Con conexión, `POST /api/v1/facial/terminals/identify` sigue verificando la
   identidad en el backend y devuelve el siguiente marcaje automático.
5. `POST /api/v1/facial/terminals/punch` sigue registrando el evento online con
   `source=tablet_facial`.

QR no se elimina ni se cambia con esta extensión.

## Sincronización de plantillas

Después del vínculo y cada vez que vuelve la conexión, la terminal solicita:

```text
GET /api/v1/facial/terminals/faces/sync?since_version=0
X-Facial-Terminal-Token: <token de la terminal>
```

La respuesta contiene `branch_id`, `terminal_id`, una revisión entera,
`upsert`, `deleted`, `attendance_state` y `full_sync`. `attendance_state` es
un resumen del día (solo entrada, almuerzo, regreso y salida) para cada rostro
autorizado; permite continuar con el siguiente paso automático después de un
reinicio sin descargar la asistencia de otras sucursales. La carga inicial usa `since_version=0`; las
siguientes solicitudes son incrementales. Si la revisión del cliente es mayor
que la del servidor (por una restauración o recreación de la tabla auxiliar),
el servidor vuelve a enviar una instantánea completa y la terminal limpia
únicamente las plantillas de esa sucursal antes de aplicarla. El servidor
filtra por `company_id`,
`branch_id`, empleado activo, autorización facial y perfil activo. Nunca
envía la foto de enrolamiento ni la ruta privada del servidor.

La PWA guarda los embeddings SFace en IndexedDB cifrados con AES-GCM. La
clave se deriva del token de terminal y de la sucursal, por lo que no se
mezclan las plantillas de otra sucursal. Si el navegador no ofrece Web Crypto,
la plantilla no se guarda.

## Marcajes offline

El motor local debe devolver solamente un `employee_id` que exista en la
plantilla cifrada de la sucursal y una similitud SFace mínima de `0.363` o
superior, además de un margen mínimo contra la segunda coincidencia. La
tablet no marca por una foto, un hash de imagen o landmarks.
MediaPipe por sí solo no es un motor de identidad: sus landmarks nunca se
usan para decidir quién es la persona.

La cola local conserva, como mínimo:

- `local_event_id` único;
- empleado, sucursal y terminal;
- fecha/hora original del dispositivo;
- tipo automático (`entrada`, `almuerzo`, `regreso` o `salida`);
- confianza, modo y coordenadas disponibles;
- estado `PENDING`, `SYNCING`, `SYNCED` o `FAILED`;
- reintentos y error operativo.

La cola sobrevive al cierre y reinicio de la PWA. Cuando hay conexión se
envían lotes de hasta 100 eventos:

```text
POST /api/v1/facial/terminals/offline-punches/sync
X-Facial-Terminal-Token: <token de la terminal>
```

El backend registra cada elemento por separado y devuelve `items` con el
estado individual. La combinación `(terminal_id, local_event_id)` es única;
repetir un lote no crea otro `attendance_event`. La hora original se conserva
para que la asistencia diaria, almuerzo, regreso, salida, tardanza y horas se
calculen sobre el momento real del marcaje. El backend vuelve a validar
terminal, sucursal, empleado, autorización, confianza, horario, geocerca y la
  secuencia automática antes de aceptar el evento.

Un fallo de transporte o del servidor se devuelve como reintentable y vuelve a
`PENDING`; un rechazo de reglas (por ejemplo, empleado desautorizado, horario
incorrecto o confianza insuficiente) queda `FAILED` para revisión y no se
reenvía en bucle.

## Eventos de sincronización

La PWA intenta sincronizar al iniciar, después del vínculo, al recibir el
evento `online` del navegador y cada cinco minutos mientras está abierta. La
APK además registra un `WorkManager` periódico (mínimo nativo de 15 minutos),
lo reprograma al arrancar el dispositivo y solicita un trabajo inmediato al
vincularse o cuando nace un evento pendiente. Ese trabajo refresca primero las
plantillas de la sucursal y luego entrega la cola de marcajes. La comprobación
útil es la respuesta del backend, no solamente que exista Wi-Fi; si el Wi-Fi
no tiene salida, el trabajo reintenta.

El proyecto conserva el indicador de conexión y agrega el estado local:

- `ONLINE` / `OFFLINE`;
- `SINCRONIZANDO`;
- cantidad de eventos pendientes;
- `LOCAL LISTO` o `LOCAL NO DISPONIBLE`.

## Cliente Android y límite de reconocimiento local

El repositorio ahora contiene un cliente Android dedicado en
`apps/facial-terminal-android/`. El cliente integra Room para plantillas y
cola de eventos, Android Keystore para cifrado, WorkManager para sincronizar
con red disponible y el puente `AllSenderAndroid` que consume la PWA. También
solicita los permisos nativos y conserva el vínculo de terminal al reiniciar.

La PWA incluye el contrato `window.AllSenderFacialLocal`:

```ts
window.AllSenderFacialLocal = {
  async recognize(imageDataUrl, { branch_id, image_width, image_height, landmarks }) {
    // El contenedor lee las plantillas cifradas de Room; no recibe embeddings por JS.
    return {
      employee_id: "...",
      confidence: 0.91,
      engine: "opencv_sface_v1",
    };
  },
};
```

El contenedor nativo implementa ese contrato con ONNX Runtime Android y el
modelo SFace compacto de 128 dimensiones empaquetado en
`models/facial/face_recognition_sface_2021dec_int8bq.onnx`. La PWA aporta los
cinco puntos de MediaPipe para la alineación; la identidad se decide solo con
la salida del encoder y las plantillas de la sucursal. ArcFace continúa
siendo compatible para perfiles existentes en el servidor, pero los perfiles
que deben trabajar offline se enrolan como `opencv_sface_v1`.

El modelo está acompañado por la licencia/atribución del directorio oficial
de OpenCV Zoo. Antes de una distribución comercial masiva se debe conservar
ese aviso y revisar la procedencia de los pesos con el proveedor del modelo.

## Borrado y cambios de autorización

Los enrolamientos, reinicios, desautorizaciones, bajas, reactivaciones y
cambios de sucursal publican una revisión. Las terminales eliminan localmente
las plantillas recibidas en `deleted`. Al cambiar de sucursal/terminal o
desvincular una terminal, el cliente nativo borra el almacén local, la cola
pendiente y sus secretos antes de aceptar el nuevo vínculo.

## Validación final antes de declarar autonomía completa

La parte backend/PWA, el encoder SFace y la base local ya tienen compilación,
pruebas de contrato y una verificación controlada en el servidor. Falta probar
en una tablet real el cliente Android con una persona autorizada y completar el
E2E: con Internet caído,
reconexión, reinicio, 100+ eventos, cambios de rostro, bajas, cambio de
sucursal, duplicados y fallos parciales.

### Matriz ejecutada en esta entrega

| Comprobación | Resultado | Evidencia o límite |
| --- | --- | --- |
| Compilación Python y pruebas del backend | OK | `235 passed, 1 warning` |
| Build de la PWA | OK | Vite transformó 1940 módulos |
| Contratos de sincronización e idempotencia | OK en pruebas de contrato | La prueba contra la base de producción requiere una terminal vinculada y autorización de despliegue |
| Build Android debug | OK | `app-debug.apk`, versión `1.0.0`, firma debug v2 válida |
| Android lint | OK | `lintDebug` sin errores; quedan advertencias de SDK/deprecaciones conocidas |
| Manifiesto, permisos y URL HTTPS | OK | Validado con `aapt`; no hay URL HTTP de aplicación |
| Instalación y cámara/GPS en tablet real | Pendiente | No había dispositivo ADB conectado en el entorno de compilación |
| Encoder local SFace/ONNX | OK en build | Modelo empaquetado, carga nativa y comparación de 128 dimensiones compiladas; requiere cámara/tablet para medir reconocimiento real |
| Reconocimiento local en una tablet | Pendiente E2E | No había dispositivo ADB conectado en el entorno de compilación |
| 100+ eventos, reinicio, caída/reconexión y modelo cambiado | Pendiente E2E | Requiere el encoder y una tablet real |

Por lo anterior, el código y el despliegue están preparados para reconocimiento
offline real, pero la APK aún no debe llamarse autonomía completa hasta
verificarla en una tablet Android real, volver a enrolar los perfiles que hoy
solo son ArcFace/LBPH y confirmar el flujo completo de sincronización y
marcaje.
