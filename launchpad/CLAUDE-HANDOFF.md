# Wire Launchpad — traspaso de Codex a Claude

Actualizado: 2026-10-14 (America/Bogota)

Este archivo resume el estado confirmado en Codex para que Claude pueda continuar sin repetir trabajo ni confundir las pruebas manuales. El usuario prefiere conversar en español, recibir instrucciones concretas y probar paso a paso. Si hay que pedirle una acción de wallet, decir exactamente qué botón tocar y esperar su resultado.

## Instrucciones prioritarias

- No leer, imprimir, sobrescribir ni versionar `backend/.env`. Está ignorado por Git. No compartir secretos ni pedir que el usuario los pegue en el chat.
- El proyecto sigue en **Devnet**. No cambiar a Mainnet ni pedir una transacción real.
- No hacer `git push` sin una instrucción explícita del usuario.
- No descartar ni resetear cambios sin commit. Hay trabajo local sobre cálculos de retiro, reintento, logs, blockhash y la identificación de wallet.
- No ejecutar `next build` mientras `next dev` esté activo; anteriormente una compilación concurrente dejó la UI sin estilos. Para una comprobación de tipos se usó `npx tsc --noEmit`.
- No intentar firmar por el usuario ni confirmar transacciones en Phantom. El usuario hace las firmas. La prueba de reintento de transacción está pendiente y no debe convertirse en una serie de intentos costosos/innecesarios.
- Mantener el aspecto actual de la UI. El usuario tuvo regresiones visuales anteriores y es sensible a cambios que quiten botones o estilos.

## Proyecto y Git

- Ruta del proyecto: `C:\Users\Usuario\Desktop\claude launcher solana\launchpad-solana-fixed-byclaude\launchpad`
- Rama activa: `codex-fixes`
- Rama actual: `codex-fixes`, HEAD `5e5845e`; alineada con `origin/codex-fixes` al iniciar la tarea de retiros.
- Los cambios anteriores de registro idempotente, página de detalle, historial, validación `RPC_WEBSOCKET` e IPFS metadata ya están subidos a GitHub (incluidos `56fe27a`, `4cc5c6f`, `82f5e32` y `5e5845e`).
- Cambios locales actuales antes del commit: telemetría de intentos y costos de creación, blockhash más fresco, cálculos exactos de retiro y pruebas, historial privado de tokens/retiros usando la sesión, autenticación por firma, panel de wallet persistente y sus pruebas, además de este handoff. No se leyó ni incluyó `backend/.env`.
- La página de detalle ya estaba comprometida; el historial sí tiene cambios locales nuevos para combinar tokens y retiros y requerir la wallet identificada.

Antes de editar, ejecutar `git status --short --branch` y revisar el diff existente. No asumir que el árbol está limpio.

## Cambios ya comprometidos en `56fe27a`

La implementación anterior arregló el error manual de Postgres `22021 invalid byte sequence for encoding UTF8: 0x00` y añadió recuperación/idempotencia para el registro de tokens:

- Limpieza de bytes nulos (`\0`) y espacios en metadata leída de Metaplex.
- Validación Zod de bytes nulos en textos libres.
- `PublicError` para errores conocidos; errores inesperados devuelven texto genérico y un `errorId`, sin loguear el payload firmado.
- `submitTransaction` valida/reutiliza la firma, consulta estado antes de reenviar, lee metadata con commitment `confirmed`, y evita registros duplicados usando mint, firma y creador.
- `P2002` se trata como éxito idempotente solo si la fila existente coincide en firma y creador.
- El frontend mantiene el payload firmado en memoria y muestra `Reintentar registro` si falla el envío/registro; no vuelve a pedir la firma. Si el blockhash expiró, limpia el payload pendiente y pide firmar otra vez.
- `successPayload` único para respuesta normal e idempotente.

Verificaciones de ese commit:

- Backend `npx tsc --noEmit`: pasó.
- Frontend `npx tsc --noEmit`: pasó.
- Backend `npm test`: 24/24 pasó.
- Integración Postgres: omitida porque no había `TEST_DATABASE_URL`; no se leyó `backend/.env` ni se usó la base normal para simular integración.
- Se subió posteriormente a `origin/codex-fixes`.

## Resultado de la prueba manual Devnet

Completado correctamente:

1. Crear token normal: Phantom mostró fee plataforma `0.02 SOL` y la UI confirmó `Token creado`.
2. Crear pool Devnet con `0.1 SOL`.
3. Retirar 25%: la UI mostró `Recibiste: 0.0225 SOL`, `Fee plataforma: 0.0025 SOL`; el balance LP bajó de ~10,000 a ~7,500.
4. Los logs del backend mostraron `slippagePercent: 1`, `baseMinAmountRaw: 24749999`, `quoteMinAmountRaw: 247499999997525000`.
5. Cancelar la firma de un token en Phantom mostró `User rejected the request`; en Manage Liquidity no apareció ese token cancelado.

Pendiente (el usuario pidió dejarlo pendiente y pasar al siguiente feature):

- Éxito del botón **Reintentar registro** con una firma todavía vigente.
- Sí se comprobó que, con el backend realmente apagado, el frontend mostró `Failed to fetch` y `Reintentar registro`.
- Al reiniciar el backend y pulsar reintento, la firma ya había expirado. La UI mostró correctamente `La transacción expiró. Vuelve a firmar.` y quitó el reintento. Esa firma no se puede reutilizar.
- Un intento anterior terminó en `Token creado` porque se cerró la terminal, pero quedó vivo el proceso hijo del backend.
- Para detener correctamente el backend, `Ctrl+C` puede dejar vivo el proceso hijo `node`. Se identificó el proceso escuchando en 4000 con:

  ```powershell
  Get-NetTCPConnection -LocalPort 4000 -State Listen
  ```

  Verificar el `CommandLine` del PID para que corresponda a `backend/.../src/index.ts` antes de terminarlo. No matar procesos por PID antiguo sin verificar.

No volver a perseguir la prueba manual a menos que el usuario decida retomarla. Si se retoma, preparar una firma nueva, coordinar una interrupción muy corta y reiniciar sin esperas/polls innecesarios. Si vence, detener ahí: la rama de expiración funciona y la firma no sirve.

## Página de detalle del token completada y subida

Se avanzó con la mejora siguiente del roadmap porque el usuario dijo que dejáramos el reintento pendiente y siguiéramos.

Implementación actual:

- Endpoint de solo lectura `GET /api/token/:mintAddress`.
- Busca por mint canónico, devuelve 400 si el mint no es una public key válida, 404 si no existe, y en éxito devuelve campos públicos: mint, name, symbol, description, image URL, total supply (convertido a string para serialización JSON), liquidez configurada, creador, fecha, txHash, pool y status.
- Página frontend `/token/[mintAddress]` con detalle del token y enlaces a Solana Explorer con `?cluster=devnet` para mint, transacción y pool.
- Link **Ver detalles del token** en el modal de token creado y **Ver detalles** desde Manage Liquidity.
- El campo de liquidez se etiqueta `SOL configurados al crear el token`; no presentarlo como balance on-chain de la pool. El valor almacenado es un parámetro del token y puede diferir de la cantidad finalmente aportada al crear el pool.
- Se usó Solana Explorer Devnet; no se agregó Dexscreener porque el proyecto está limitado a Devnet.

Comprobaciones del feature (último estado conocido):

- Backend y frontend `npx tsc --noEmit`: pasaron antes de un último ajuste solo de copy/etiqueta.
- `git diff --check`: sin errores; Git muestra advertencias normales de conversión LF/CRLF en Windows.
- GET real `http://localhost:4000/api/token/3DvVEU3BXE3Yh5HceFNDQp3s1jLYXh9p3eSQu9Tob2qs` respondió éxito para `daad (ADWA)`, supply serializado como string, pool `67fomiGsva1Sozp2eB5J42AvT3Qowt8iixdBYdfttvQQ`.
- `http://localhost:3000/token/3DvVEU3BXE3Yh5HceFNDQp3s1jLYXh9p3eSQu9Tob2qs` respondió HTTP 200.
- Redis puede devolver 503 temporal justo al arrancar el backend. En comprobaciones anteriores, `docker exec launchpad-redis-1 redis-cli ping` devolvió PONG y un segundo request funcionó. No confundir esa demora con error del endpoint de detalles.
- No se ejecutaron tests nuevos ni `next build` para este feature.

## Página de detalle: comprobaciones ya realizadas

La página se probó visualmente y sus enlaces apuntan a Explorer Devnet. El campo de liquidez se presenta como el SOL configurado al crear el token, no como reserva actual. El feature fue subido según el tracker.

## Texto corto para iniciar a Claude

Continúa desde el estado de `CLAUDE-HANDOFF.md`. Revisa `git status` y el diff actual; conserva los cambios de extracción y pruebas del cálculo de retiros. No leas/modifiques `backend/.env`, no ejecutes `next build` mientras `next dev` esté corriendo, no firmes transacciones por el usuario y no hagas push sin autorización. El caso feliz del botón Reintentar registro sigue pendiente; no repetir esa prueba salvo que el usuario lo pida.

## Validación RPC_WEBSOCKET completada y subida

Aplicado el 2026-10-12, sin leer ni imprimir `backend/.env`:

- Si `RPC_WEBSOCKET` está configurado y `NODE_ENV=production`, exige prefijo `wss://`.
- Fuera de producción acepta `ws://` o `wss://`.
- Si la variable está ausente o vacía, se conserva el valor vacío y no se valida, sin cambiar el comportamiento opcional.
- La configuración exportada reutiliza el valor ya validado en `rpcWebsocket`.
- No se encontró un archivo de pruebas específico de configuración existente; no se creó uno nuevo ni se añadió un caso a otro suite.
- El cambio se confirmó en el commit `4cc5c6f` y está subido según el tracker. No hay modificación local pendiente en `config.ts`.

## Historial de tokens por wallet completado y subido

Se añadió una implementación local inicial del punto 2 del roadmap:

- Nuevo `GET /api/my-tokens?userWallet=<public key>`, con validación Zod de la public key, canonicalización con `PublicKey` y respuesta ordenada por creación descendente.
- Devuelve solo campos públicos del token: mint, nombre, símbolo, imagen, estado, pool y fecha. Errores internos responden con mensaje genérico.
- La ruta queda bajo el rate limit global de `/api` existente.
- `ManageLiquidity` sigue mostrando las pools. Debajo, el nuevo componente `TokenHistory` lista todos los tokens registrados para la wallet conectada, incluso si aún no tienen pool, con enlace al detalle.
- Se agregaron pruebas para validación, orden por fecha, límite, wallet sin tokens y errores genéricos.
- El feature se subió según el tracker en `82f5e32`; el estado traducido también se subió en `60a72d8`.

## Revisión del margen de creación con BASE_FEE_SOL=0.02

Revisión estática del código y cálculo con los importes de la transacción de creación Devnet que el usuario compartió. No se cambió el fee ni se leyó `backend/.env`.

- `tokenController.ts` incluye una transferencia de 0.02 SOL desde la wallet creadora hacia `PLATFORM_FEE_WALLET` en la transacción.
- `mintService.ts` usa la wallet del servidor como payer para crear la cuenta mint, el Associated Token Account y la cuenta de metadata Metaplex. El `feePayer` de la transacción se configura como la wallet creadora, así que la comisión de red observada la paga el usuario aparte del fee plataforma.
- Importes de rent observados en la transacción Devnet compartida: mint 0.0010668 SOL; token account 0.00148844 SOL; metadata 0.0137338 SOL. Total financiado por el server: 0.01628904 SOL.
- Diferencia nominal contra 0.02 SOL: 0.00371096 SOL (aprox. 18.55% del fee), antes de gastos de Pinata, operación, variabilidad de tamaño de metadata y costos de transacciones fallidas/reintentos. No debe describirse como margen neto.
- El fee va a `PLATFORM_FEE_WALLET` mientras que rent se paga desde `SERVER_WALLET_PRIVATE_KEY`; son roles/configuración distintos. El código revisado no hace un traspaso automático de ingresos del fee wallet a la wallet del servidor.
- `createToken` sube imagen y JSON a Pinata antes de que el usuario firme. Si luego cancela, no se observó una rutina de unpin/limpieza en `ipfsService.ts`; esos objetos podrían quedar huérfanos y el plan/costo operativo de Pinata no está cuantificado.
- Recomendación: 0.02 SOL parece un margen estrecho para Mainnet mientras no se midan costos reales de Pinata, variación de rent y tasa de abandono. Mantenerlo como valor Devnet está bien para pruebas; antes de Mainnet definir un colchón explícito, separar y fondear la server wallet, y medir varias transacciones con metadata de distintos tamaños. No cambiar la tarifa sin decisión del usuario.

## Cobertura automatizada nueva para cálculos de retiro

El 2026-10-13 se extrajo el cálculo puro a `backend/src/services/withdrawalMath.ts` y se integró de nuevo en `raydiumService.ts`:

- Conserva `BigInt` para montos raw, selección de reserva SOL por orden de los mints, redondeo pro-rata previo al slippage y mínimos del 99% para ambos lados.
- Divide el output SOL en lamports enteros: fee plataforma de 10% redondeado hacia abajo; el usuario recibe el resto para que las partes sumen exactamente el output total. La instrucción de transferencia usa esos lamports exactos.
- Rechaza LP amount 0, supply 0, entradas mal formadas y una cantidad LP por encima del supply total. También rechaza un fee fuera del rango numérico seguro que admite `SystemProgram.transfer`.
- Añade 8 pruebas de unidad para 25%, 50%, 75%, 95%, ambos órdenes de mints, floors de slippage, precisión BigInt grande y entradas inválidas.
- Verificación: `npx tsc --noEmit` backend pasó; prueba dirigida `npx tsx --test tests/withdrawal-math.test.ts` pasó 8/8; `npm test` pasó 56/56; `git diff --check` sin errores. No se hizo retiro on-chain ni se modificó el frontend.
- Cambios actuales sin commit: `backend/package.json`, `backend/src/services/raydiumService.ts`, `backend/src/services/withdrawalMath.ts`, `backend/tests/withdrawal-math.test.ts` y `CLAUDE-HANDOFF.md`.
- Próximo paso: revisar el diff y decidir si estos cálculos cubren los escenarios requeridos. Para comprobación de integración basta una transacción de Devnet controlada; no hace falta repetir cuatro retiros manuales.

## Preparación de producción: formato de logs

El 2026-10-13 `backend/src/utils/logger.ts` se ajustó para usar logs JSON de Pino cuando `NODE_ENV=production`; en desarrollo se conserva `pino-pretty`. Esto evita que el transporte de consola formateada interfiera con colectores de logs en producción y no cambia la UI ni la configuración Devnet.

- Verificación después del cambio: backend `npx tsc --noEmit` pasó; `npm test` pasó 56/56; `git diff --check` pasó.
- `logger.ts` queda sin commit junto con el trabajo local de cálculos de retiro. No se hizo push.
- La auditoría de preparación para producción no está completa. La autenticación con firma, configuración de despliegue/secretos, observabilidad y operación Mainnet siguen requiriendo diseño y revisión separados. No cambiar la red fuera de Devnet sin decisión explícita.

## Blockhash más fresco para firma de creación

El 2026-10-13 `createToken` cambió a `connection.getLatestBlockhash('confirmed')` antes de devolver la transacción firmada parcialmente. El commitment predeterminado de web3.js es `finalized`; usar `confirmed` evita entregar un hash varios slots más viejo y conserva baja probabilidad de fork. Esto no aumenta la vida máxima del protocolo: los recent blockhashes duran hasta 150 slots. Las firmas normales de Phantom siguen sujetas a esa expiración.

- Es una mejora de la ventana disponible para que la persona firme; no garantiza minutos adicionales.
- Para cerrar el caso feliz del botón `Reintentar registro`: preparar el formulario primero, tener backend listo, apagarlo solo después de que ya aparezca Phantom, confirmar y volverlo a encender inmediatamente; luego pulsar el botón. El backend necesita recibir el payload firmado antes de que caduque el blockhash.
- Se verificó tras el cambio: backend `npx tsc --noEmit` pasó; `npm test` pasó 56/56; `git diff --check` pasó.

## Caso de reintento: cobertura determinista

La repetición manual se detuvo porque el blockhash caducó mientras el backend estaba apagado. Para no insistir en una carrera de tiempo, se agregó a `backend/tests/controller-handlers.test.ts` una prueba combinada: el primer intento envía y confirma la transacción, falla el guardado de base simulado y el segundo intento detecta la firma finalizada, no vuelve a transmitir y registra el mismo token.

- Verificación actual: backend `npx tsc --noEmit` pasó; `npm test` pasó 57/57.
- Esto valida el flujo backend de recuperación de forma determinista; no reemplaza una prueba visual de Phantom, pero ya no hace falta repetir el corte manual para confirmar que el registro idempotente evita un segundo envío.
- El backend local sigue encendido bajo la sesión de terminal de Codex. No se deben hacer más intentos de creación en Devnet salvo que el usuario los solicite.

## Identificación de wallet por firma (alcance elegido)

El 2026-10-13 se implementó una identificación explícita de wallet por mensaje, sin transacción ni gasto de SOL. El usuario eligió “solo identificar wallet”; esta sesión no autoriza operaciones ni reemplaza las firmas de Phantom para crear pools o retirar.

- Backend: `POST /api/auth/challenge` genera un mensaje ligado a wallet, Origin y nonce aleatorio; Redis almacena el reto cinco minutos. `POST /api/auth/verify` consume el reto con `GETDEL`, verifica la firma Ed25519 y entrega una cookie opaca `HttpOnly`, `SameSite=Lax`, de 24 horas (`Secure` en producción). `GET /api/auth/session` informa la identidad actual y `POST /api/auth/logout` invalida la sesión.
- Frontend: `WalletIdentityProvider` consulta la sesión y `WalletConnector` ofrece `Identificar` / `Wallet identificada`. Requiere que el adapter soporte `signMessage`; Phantom y Backpack normalmente exponen esta capacidad. Cancelar el mensaje no afecta fondos ni crea una transacción.
- Las rutas de auth quedan bajo el límite de API global y tienen rate limits específicos. CORS admite credenciales, y el origen se liga al challenge y se valida contra `CORS_ORIGINS`.
- Pruebas: retos válidos, expiración, replay, origen incorrecto, firma incorrecta y cookie/sesión. Recorrido local real contra backend+Redis con keypair efímera: challenge 200, verify 200, session identificada, logout y sesión invalidada. No se usó Phantom ni Devnet para esta prueba.
- Verificación final tras `Cache-Control: no-store`: typecheck backend y frontend pasaron; suite backend 61/61; `git diff --check` pasó. API local devolvió session 200/no-store y preflight CORS 204 con credentials.
- Recorrido HTTP real de challenge/verify/session/logout contra backend y Redis local pasó con una keypair efímera.
- Revisión manual visual en Devnet completada: el panel persistente muestra Phantom, dirección abreviada, estado `Identificada` y balance. El usuario pidió un airdrop de 1 SOL; el saldo cambió de 6.7956 a 7.7956 SOL sin recargar, verificando el listener de cuenta en tiempo real. El usuario confirmó que `Identificada` persistió después de recargar.
- El nombre que muestra la UI es el proveedor (por ejemplo, Phantom) junto con la dirección abreviada; Wallet Adapter no expone el apodo interno de la cuenta de Phantom.
- Pendiente antes de desplegar: elegir hosting y dominios. Si frontend y API están en sitios distintos, revisar política `SameSite`/cookies y CSRF con los dominios reales; no desplegar esta configuración a Mainnet todavía.

## Guardrails de preparación para producción (commit `fc1f904`, ya subido)

El 2026-10-13 se cerraron varios hallazgos de la revisión estática. El commit `fc1f904` quedó subido a `origin/codex-fixes` antes del trabajo de limpieza de Pinata descrito abajo:

- `backend/src/utils/config.ts`: producción ahora exige `PINATA_JWT` y al menos un origen CORS real en `CORS_ORIGINS`; los valores vacíos/comas ya no pasan como configuración válida. No se abrió ni modificó `backend/.env`.
- `GET /health/live` es una comprobación de proceso; `GET /health/ready` prueba Postgres y Redis y responde 503 si alguno no está disponible, sin filtrar detalles al cliente. `/health` conserva compatibilidad como liveness.
- El backend cierra el servidor HTTP, Prisma y Redis al recibir SIGINT/SIGTERM.
- La creación de token requiere sesión de wallet firmada que coincida con `userWallet` antes de llamar a Pinata. El frontend envía la cookie con `credentials: 'include'`. Se conserva el límite por IP y se agrega un máximo de cinco preparaciones por wallet cada 15 minutos.
- Typecheck `npx tsc --noEmit` pasó en backend y frontend; la suite `npm test` pasó 64/64 después de añadir cobertura de sesión ausente, wallet distinta, wallet coincidente y límite por wallet; `git diff --check` pasó. No se ejecutó `next build`.
- Verificación de ese commit: `npm test` 64/64, typecheck backend/frontend y `git diff --check` pasaron.

Pendiente para un despliegue concreto: elegir hosting/dominios, configurar el número correcto de proxies confiables (`TRUST_PROXY_HOPS`), validar cookies/CORS con esos dominios y configurar probes del host a `/health/ready`. Mantener Devnet; no hacer migración a Mainnet como parte de esta preparación.

## Limpieza de pins huérfanos de Pinata (commit local `2251860`, sin push)

El 2026-10-13 se implementó el seguimiento y limpieza de archivos subidos al preparar un token:

- Cada `attemptId` guarda en Redis la wallet, mint cuando ya existe, CIDs subidos y firma cuando el cliente envía la transacción.
- Si falla la preparación antes de devolver una transacción, el servidor intenta despinnear los CIDs conocidos.
- Cuando Phantom rechaza la firma, `/api/token-attempt/outcome` valida wallet/mint contra el intento y limpia los CIDs. El trabajo lo ejecuta el backend, no depende de mantener abierta la página.
- Los intentos abandonados se revisan después de 24 horas; un worker ligero corre cada minuto. Si Solana confirma la firma, conserva los archivos. Si sigue procesándose, aplaza la limpieza.
- Antes de despinnear, el backend busca referencias de imagen en la DB y referencias de metadata en tokens ya registrados on-chain. Si DB/RPC no permiten comprobarlo, no elimina ese CID en ese ciclo y vuelve a intentarlo.
- Pinata documenta `DELETE /pinning/unpin/{CID}` para quitar el pin de la cuenta. Esto no borra el contenido de IPFS de otros nodos.
- Pruebas unitarias añadidas para cancelación, propiedad wallet/mint, preservación de transacciones confirmadas y barrido de intentos abandonados.
- Verificación actual: backend y frontend `npx tsc --noEmit` pasaron; backend `npm test` pasó 68/68; `git diff --check` pasó. No se ejecutaron pruebas de integración ni se despinneó ningún CID real durante la implementación.
- Los cambios quedaron en el commit local `2251860` (`Clean up abandoned Pinata token uploads`); la rama `codex-fixes` está un commit por delante de `origin/codex-fixes`. No hacer push hasta que el usuario lo pida. No se modificaron ni limpiaron manualmente archivos existentes en Pinata.

## Estado de la lista original de Claude

- Imagen y descripción servidas desde metadata del servidor: implementado.
- Historial de tokens por wallet: implementado.
- Revisión del fee de 0.02 SOL: análisis hecho; el margen antes de Pinata/infra es estrecho y no es margen neto.
- Escenarios de retiro: cálculos y pruebas unitarias implementados.
- Login por firma para identificar la wallet: implementado y probado en Devnet.
- **Rediseño visual de UI: sigue pendiente**, separado del trabajo de backend; el usuario indicó dejarlo para la etapa de UI.
- Hosting, dominios e infraestructura de producción: dejarlos para el final; mantener Devnet entretanto.
