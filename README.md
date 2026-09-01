# AllSender Facial

Terminal web y PWA de marcaje facial automático para AllSender Nómina.

Este repositorio contiene únicamente el cliente de la terminal: cámara, detección facial en vivo, vinculación GPS + PIN, estado de batería, instalación PWA, avisos visuales y voz, selección automática del siguiente marcaje y comunicación con la API facial real.

La API, la base SQL, los empleados, las sucursales, los horarios y la asistencia permanecen en el repositorio principal de Nómina. La terminal no contiene datos biométricos, tokens, claves de producción ni una base de datos paralela.

## Desarrollo local

```bash
npm ci
npm run dev
```

La terminal se abre en `http://localhost:5174/facial-terminal`. El proxy local espera la API de Nómina en `http://127.0.0.1:8030`.

## Build

```bash
npm run build
```

## Contrato de producción

La terminal utiliza los endpoints reales bajo `/api/v1/facial/terminals/`:

- `pair`
- `config`
- `heartbeat`
- `locate`
- `identify`
- `punch`

El origen del evento de asistencia generado por la terminal es `tablet_facial`.

## Flujo automático de marcaje

La terminal no le pide al empleado escoger ni confirmar el tipo de marcaje. Después de identificar un rostro autorizado, consulta el estado de asistencia del día en la API y muestra únicamente el siguiente paso permitido:

1. Sin entrada registrada: **Entrada**.
2. Entrada registrada antes de la ventana de almuerzo: espera y explica cuándo estará disponible el almuerzo.
3. Dentro de la ventana de almuerzo: **Almuerzo**.
4. Almuerzo abierto: **Regreso**.
5. Almuerzo cerrado y llegada del fin del horario: **Salida**.
6. Salida registrada: jornada completa; la terminal vuelve a esperar.

La tardanza no es un marcaje separado. El motor central la calcula al registrar la entrada, comparando la hora real con el horario efectivo de la sucursal y sus minutos de gracia. El mismo motor calcula horas del día, exceso de almuerzo y estado de la jornada.

La terminal no marca una salida laboral solamente porque el empleado se aleje físicamente: la ubicación valida la tablet, no sigue al empleado. La salida se registra cuando el empleado vuelve a ser reconocido y el estado del día, junto con la hora de la sucursal, determina que corresponde `salida`. Si se va a almorzar debe ser reconocido para registrar `almuerzo`; al volver, el siguiente reconocimiento registra `regreso`.

El modo automático debe estar activado en la configuración de la sucursal. Si está desactivado, la terminal no ofrece botones de confirmación manual: informa que la sucursal necesita activar el modo automático para operar de forma segura.

## Sonido y guía visual

El sonido comienza desactivado en cada sesión. El operador puede activarlo manualmente desde el control de audio si la operación de la sucursal lo requiere. La guía principal es visual: estados en vivo, color de autorización, flujo de cuatro pasos, instrucciones de cámara y retorno automático al estado de espera.
