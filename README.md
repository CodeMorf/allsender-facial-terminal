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
