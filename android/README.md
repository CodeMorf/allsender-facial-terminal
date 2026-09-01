# AllSender Facial Terminal para Android

Cliente Android dedicado para abrir la terminal facial web de AllSender en
una tablet. La marca visible es **AllSender Facial**; CodeMorf solo aparece
como autoría técnica en la documentación del proyecto.

## Versión

- Versión de aplicación: `1.0.0`
- Código de versión: `10000`
- Ruta web cargada: `/facial-terminal`
- Backend: `https://nomina.allsender.tech`

## Qué aporta este cliente

- Pantalla completa y permanencia activa de la tablet.
- Inicio automático del programador de sincronización después de reiniciar.
- Cámara, GPS y notificaciones mediante permisos Android.
- Almacenamiento local cifrado con Android Keystore.
- Cola Room para marcajes offline y WorkManager para reintentar cuando haya
  conexión real.
- Validación de sucursal y terminal antes de guardar datos locales.
- Reconocimiento local SFace mediante ONNX Runtime cuando el perfil sincronizado
  de la sucursal también fue enrolado con `opencv_sface_v1`.
- El motor nativo lee los embeddings únicamente desde Room cifrado; el puente
  JavaScript no recibe ni transporta el catálogo biométrico.
- Al cambiar o desvincular la terminal se eliminan rostros, metadatos y eventos
  pendientes del vínculo anterior.

## Estado de reconocimiento offline

La aplicación contiene el modelo SFace compacto de OpenCV Zoo y lo ejecuta
localmente con ONNX Runtime. MediaPipe, que ya usa la PWA, detecta un solo
rostro y entrega cinco puntos para alinear la captura; SFace calcula la
identidad y exige similitud/margen mínimos antes de permitir un marcaje.

Los perfiles antiguos que solo tienen InsightFace/ArcFace o LBPH siguen
funcionando online, pero deben volver a registrarse para recibir una plantilla
`opencv_sface_v1` y poder marcar sin Internet. Si no existe una plantilla SFace
válida, la APK informa “motor local no disponible” y no genera un marcaje
offline. No se sustituye por comparación de píxeles, landmarks o respuestas
fijas.

El modelo y su aviso de atribución están en `models/facial/NOTICE.md`.

## Permisos y modo terminal

El instalador solicita cámara, ubicación precisa y notificaciones. El bloqueo
total de salir a otras aplicaciones depende de que la tablet esté administrada
como dispositivo dedicado (Device Owner / Lock Task); una APK por sí sola no
puede elevar ese permiso de administración.

## Compilación

Desde esta carpeta, con Android SDK y JDK 17 o superior:

```powershell
./gradlew.bat assembleDebug
```

El APK debug se genera en `app/build/outputs/apk/debug/`. No se debe publicar
una APK como producción hasta completar el modelo local, pruebas en tablet y
los escenarios offline descritos en `docs/facial-offline.md`.
