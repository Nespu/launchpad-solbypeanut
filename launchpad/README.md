# Launchpad de Memecoins en Solana — Guía de arranque

Este proyecto tiene 3 partes que corren por separado:

1. **PostgreSQL + Redis** (vía Docker)
2. **Backend** (Express + TypeScript, puerto 4000)
3. **Frontend** (Next.js, puerto 3000)

No hay atajos aquí: para que esto funcione de verdad necesitas cuentas y claves reales.
Sigue el orden exacto de abajo.

---

## Verificación de esta etapa — 17 de octubre de 2026

- `backend`: 87 pruebas pasan; `tsc --noEmit` pasa en backend y frontend.
- `next build` generó todas las rutas de producción al compilar una copia limpia del
  frontend con salida separada del `.next` que usa el servidor local.
- Se revisaron las claves literales `t()` en 28 archivos TypeScript del frontend; no quedó
  ninguna sin traducción al inglés. El selector nativo del proveedor de wallet conserva
  algunos textos propios del proveedor.
- Las pruebas de integración con Postgres y Redis pasaron en contenedores desechables.
- El backend local respondió `ready`. La consulta pública de solo lectura al mint
  USDC de Devnet confirmó seis decimales; todavía falta una operación USDC que revises
  y firmes en Phantom.
- `npm audit --omit=dev` contó 5 avisos altos y 7 moderados en backend, y 14 altos
  y 14 moderados en frontend. Son avisos del grafo de dependencias, no una prueba de que
  cada ruta de Wire sea explotable. Incluyen Solana, Next/PostCSS y wallet adapters;
  algunos carecen de parche upstream y las correcciones automáticas proponen saltos mayores.
  No se aplicaron actualizaciones forzadas.
- La revisión visual de las pantallas en navegador sigue pendiente. Los flujos SOL que
  ya probaste no sustituyen la validación visual y de firma de cada ruta USDC.

### Límites técnicos conocidos

- El blockhash puede vencer o no ser reconocido por el mismo RPC. Token, pool y retiro
  comprueban su vigencia antes de solicitar firma; el retiro vuelve a preparar la revisión
  vencida para que revises de nuevo. Wire no reenvía automáticamente una transacción.
- La creación de pools usa Raydium CPMM y requiere que revises y firmes desde tu wallet.
  El aporte inicial de liquidez es parte de esa transacción.
- Retirar el 100% vacía los LP de esa wallet; no cierra ni elimina la pool. Quemar LP es
  irreversible y no forma parte del retiro. El bloqueo temporal de LP no está disponible.

---

## 0. Requisitos previos (instalar una sola vez)

- **Node.js 20+** → https://nodejs.org
- **Docker Desktop** → https://www.docker.com/products/docker-desktop (para Postgres y Redis sin instalarlos a mano)
- Una wallet de Solana (Phantom) instalada en tu navegador, en **Devnet** primero, no en mainnet, hasta que todo funcione.

---

## 1. Levantar la base de datos y Redis

```bash
cd launchpad
docker compose up -d
```

Esto levanta Postgres en `localhost:5432` y Redis en `localhost:6379` con las credenciales
que ya están en `docker-compose.yml` (usuario/clave: `launchpad`/`launchpad`).

Verifica que están corriendo:
```bash
docker ps
```
Deberías ver dos contenedores: `postgres` y `redis`.

---

## 2. Configurar y correr el backend

```bash
cd backend
npm install
cp .env.example .env
```

Ahora abre `.env` y rellena estas 3 cosas **antes de continuar**:

### a) RPC de Solana
Regístrate gratis en **Helius** (https://helius.dev) o **QuickNode** (https://quicknode.com),
crea un endpoint de **Devnet** (no mainnet todavía) y copia la URL en `RPC_ENDPOINT`.

### b) Wallet del servidor
Esta wallet solo paga fees de red, nunca guarda fondos de usuarios. Genera una nueva:
```bash
npx @solana/web3.js  # o usa `solana-keygen new --outfile server-wallet.json`
```
Si usas `solana-keygen`, convierte la clave a base58 para pegarla en `SERVER_WALLET_PRIVATE_KEY`:
```bash
node -e "console.log(require('bs58').encode(Buffer.from(require('./server-wallet.json'))))"
```
Luego, mándale un poco de SOL de Devnet gratis (faucet): https://faucet.solana.com — pega la
dirección pública de esa wallet ahí.

### c) Wallet de cobro
`PLATFORM_FEE_WALLET` = la dirección pública **de tu propia wallet** (donde quieres recibir
las comisiones). Puede ser tu Phantom normal. Esta NO necesita clave privada en el `.env`.

### d) Pinata (para subir imágenes/metadata a IPFS)
Crea cuenta gratis en https://pinata.cloud → API Keys → genera un JWT → pégalo en `PINATA_JWT`.

Ahora corre las migraciones de base de datos:
```bash
npx prisma migrate deploy
npx prisma generate
```

Las migraciones versionadas crean el esquema base si aún no existe y agregan
integridad de transacción a los retiros. Los retiros antiguos conservan su
historial, pero no tienen huella firmada y no se pueden reconciliar mediante
la nueva verificación.

Y levanta el servidor:
```bash
npm run dev
```
Deberías ver `Server running on port 4000`. Prueba que responde:
```bash
curl http://localhost:4000/health
```

Para monitorización, `/health/live` confirma que el proceso responde y
`/health/ready` comprueba PostgreSQL, Redis y el RPC de Solana. La disponibilidad
responde con `503` si una dependencia falla o tarda más de 3 segundos.

---

## 3. Configurar y correr el frontend

En otra terminal:
```bash
cd frontend
npm install
cp .env.example .env.local
```

El `.env.local` que acabas de crear ya trae los valores correctos para Devnet por
defecto — solo revisa que `NEXT_PUBLIC_API_URL` apunte al backend que levantaste en
el paso 2 (por defecto `http://localhost:4000`, no hace falta tocarlo si no cambiaste
el puerto).

La wallet lee el saldo directamente del RPC de Solana; iniciar sesión con firma
también necesita que el backend sea accesible desde el navegador. `localhost` y
`127.0.0.1` cuentan como orígenes distintos: usa en `CORS_ORIGINS` el origen exacto
que aparece en la barra del navegador, incluyendo protocolo y puerto. Si cambias
`NEXT_PUBLIC_API_URL`, reinicia Next.js para que el nuevo valor se incluya en el
frontend.

Corre:
```bash
npm run dev
```
Abre http://localhost:3000, conecta Phantom (cambiado a Devnet en su configuración),
y prueba crear un token con poca liquidez para no gastar de más mientras pruebas.

---

## 4. Estado actual del producto

### Disponible en Devnet

- Conexión de wallet, inicio de sesión con firma, formulario de token, subida a IPFS,
  mint SPL y metadata Metaplex.
- Creación de pool CPMM de Raydium con SOL; la ruta de USDC está implementada en código,
  pero aún no tiene una creación firmada y verificada en Devnet. Wire prepara retiros que
  revisas y firmas; la plataforma cobra 10% de la salida estimada en el activo de cotización
  de la pool dentro de esa transacción. Un retiro directo desde otra interfaz no pasa por
  Wire y no aplica esa comisión.
- Las rutas de historial requieren una sesión firmada y limitan los resultados por
  wallet. FeePayment registra de forma idempotente el importe exacto en lamports tras
  confirmar la transacción.
- El detalle de tokens con pool CPMM permite cotizar y preparar compras/ventas SOL en
  Devnet, ya confirmadas en cadena. El camino de USDC está implementado, pero falta una
  compra y una venta firmadas para verificarlo end-to-end. El panel explica que el creador
  no necesita comprar su token y qué revisar antes de firmar. Wire registra swaps solo
  después de verificar la transacción confirmada, la pool, la wallet y el cambio de tokens.
- El historial de swaps nuevos verifica el evento CPMM de Raydium y muestra el cambio de
  tokens, flujo SOL, fee de red, slot y enlaces a Explorer. Los registros previos al
  seguimiento del flujo SOL conservan ese campo vacío. No estima PnL ni convierte la
  actividad a USD.
- El resumen de actividad muestra el flujo neto SOL de los swaps registrados por Wire:
  ventas menos compras y fees de red. No lo presenta como PnL porque excluye transferencias,
  posiciones abiertas y actividad fuera de Wire; si faltan importes verificados lo marca
  como parcial.
- Activos de wallet: consulta SOL y tokens SPL/Token-2022 de la wallet conectada y hasta 10
  direcciones públicas de solo lectura. Las direcciones se pueden agrupar como Dev,
  Bundle o Snipe; se pueden importar/exportar como JSON público y se guardan localmente
  en el navegador. Son direcciones de solo lectura: no son wallets gestionadas, no financian
  direcciones ni ejecutan compras.
- Bóveda local de wallets de proyecto: genera wallets o importa claves Solana bajo una
  contraseña, cifra las claves con scrypt y AES-GCM en IndexedDB, se bloquea por inactividad
  y permite descargar/restaurar una copia cifrada. El archivo local no se envía al backend;
  no hay exportación de claves sin cifrar. «Mis wallets» (`/wallets`) mantiene esta bóveda
  separada del seguimiento público de direcciones, y reúne balances e historial. Ya permite
  financiar hasta 10 wallets guardadas por transferencia SOL en Devnet: origen en la wallet
  conectada, importes iguales o individuales, edición local de nombre y rol, desglose de saldos
  y comisión, firma explícita en el proveedor y estado verificable con enlace a Explorer. La
  última firma y su estado se conservan localmente para evitar repetir un envío pendiente.
  Los saldos SOL de la bóveda
  se consultan en lote; los balances SPL y Token-2022 se consultan por wallet al desplegar su
  detalle. Son consultas públicas de solo lectura. Las claves guardadas no firman estos envíos
  ni se usan en compras; cada operación requiere aprobación y no simula volumen.
- Presets locales de lanzamiento: reutilizan supply, SOL de liquidez, medidas de
  seguridad y la selección de hasta 10 wallets públicas de la bóveda. En el paso Oferta,
  el asistente permite elegir wallets y, tras crear el token, enlaza con Mis wallets para
  preseleccionarlas como destinos de financiación SOL. La selección no ejecuta compras.
  Los datos propios de cada token (nombre, imagen y redes sociales) se vuelven a definir
  en cada creación.
- El asistente de creación ya tiene cinco pasos: Identidad, Metadatos, Oferta, Seguridad
  y Revisión. Identidad exige nombre, símbolo e imagen; el resumen final detalla el fee
  antes de crear. Antes de la pool, Wire muestra por separado los tokens y SOL que entran
  a la liquidez, la tarifa de Wire (0 SOL) y los fondos para cuentas y fee de red.
- Limpieza diferida y por lotes de intentos abandonados y sus archivos IPFS. Los intentos
  cancelados esperan una ventana de gracia; los que ya se enviaron se conservan si la
  firma confirma en Solana.
- Conciliación por lotes de retiros expirados cuyo resultado no se pudo guardar después
  de transmitir la transacción. Los barridos no repiten indefinidamente la primera página.
- El apagado ordenado detiene los temporizadores y espera a los barridos activos antes de
  desconectar Redis y PostgreSQL.
- `/health/live` indica que el proceso responde; `/health/ready` consulta PostgreSQL,
  Redis y Solana RPC con un límite de espera.

### Límites y trabajo pendiente

- Todo el flujo actual usa Solana Devnet. No desplegar en Mainnet sin revisión de
  seguridad, pruebas de integración con Postgres y Redis, verificación de fees reales,
  HTTPS y configuración de secretos en el hosting.
- Retirar el 100% de los LP vacía la posición de esa wallet, pero no cierra ni elimina
  la pool de Raydium. La cuenta de la pool sigue existiendo on-chain. Quemar LP es
  irreversible y no forma parte automática del retiro; el bloqueo temporal tampoco
  está disponible en la interfaz.
- El asistente actual no incluye todavía los modos de compra coordinada y automatizaciones
  del flujo Svarog/Vortex. Esas capacidades siguen en la hoja de ruta por fases; la lista
  completa no se descarta. La guía de Vortex separa la preparación pre-lanzamiento
  (proyecto, metadatos, wallets, fondos y modo de lanzamiento) del Swap Manager posterior;
  Svarog también separa crear, financiar, lanzar/agrupar compras y seguir posiciones.
  Wire conservará sus cinco pasos principales y organizará esas capacidades en dos áreas:
  preparación del lanzamiento y espacio del token ya lanzado (resumen, wallets, trading,
  liquidez e historial). Una compra agrupada al lanzamiento no es el mismo flujo que un
  swap individual posterior. El panel de swap actual seguirá siendo una compra/venta normal
  desde la wallet activa; el creador no necesita comprar para lanzar.
- La hoja de ruta mantiene Pump.fun/Mayhem, bundling Jito, operaciones multi-wallet,
  automatizaciones con límites visibles (Bump Bot, Smart Sell, TP y reintentos),
  lanzamientos por lotes, market making transparente y analítica de PnL. Cada acción
  multi-wallet deberá indicar wallets de origen/destino, importe por wallet, total, tarifas,
  slippage, mínimo recibido y estado verificable en cadena. La bóveda local cifrada y el
  fondeo Devnet explícito desde la wallet conectada ya están implementados. La selección de
  wallets ya forma parte del paso Oferta y se conecta al flujo de financiación; falta la firma
  multiwallet de compras y demás operaciones. Las claves privadas no se enviarán al backend.
  Los retrasos configurables servirán para controlar la ejecución, no para imitar actividad
  humana ni esconder relaciones entre wallets.
- El swap disponible cubre las pools CPMM de Wire en Devnet. USDC está implementado en
  código; su validación firmada sigue pendiente.
- Wire no debe simular demanda ni volumen. Las funciones de trading automatizado deben
  mostrar las operaciones reales, sus límites, costos, estado y mecanismo de cancelación.
- El historial y el calendario muestran tokens, pools, retiros y swaps CPMM que Wire
  registra; todavía no reconstruyen toda la actividad de la wallet ni resultados de
  trading.
- Los retiros cancelados, expirados o completados se conservan en PostgreSQL como historial;
  Wire no elimina esos registros al limpiar intentos temporales. La interfaz oculta por
  defecto los intentos cancelados antes de firmar y permite desplegarlos.

Las migraciones versionadas incluyen los campos exactos de retiros, índices de historial,
la tabla de swaps verificados y soporte de activo de cotización. Las migraciones anteriores
se reconciliaron en la base local. La migración de activo de cotización se probó en un
Postgres desechable; todavía no se aplicó a la base de desarrollo del usuario. Antes de
aplicarla a otra base, revisa su `_prisma_migrations` y respáldala. No uses `migrate reset`
para resolver una divergencia porque podría borrar datos.

---

## Checkpoints — cómo confirmar que cada pieza funciona (en orden)

No pruebes todo junto a la primera. Si algo falla, esto te dice exactamente en qué
capa está el problema en vez de adivinar.

**✅ Checkpoint 1 — Infra**
```bash
docker ps
```
Debes ver `postgres` y `redis` con estado `Up`. Si no aparecen, `docker compose up -d`
no corrió bien — revisa `docker compose logs`.

**✅ Checkpoint 2 — Variables de entorno cargan sin crashear**
```bash
cd backend && npm run dev
```
Si falta o está vacía alguna de `RPC_ENDPOINT`, `PLATFORM_FEE_WALLET`,
`SERVER_WALLET_PRIVATE_KEY` o `DATABASE_URL`, el servidor va a morir inmediatamente
con `Missing required env var: X` — te dice cuál falta, no hay que adivinar. Si el
valor de `PLATFORM_FEE_WALLET` quedó con el placeholder del `.env.example`
(`TuDireccionPublicaDeCobro`), va a morir distinto: `Invalid public key input`.

**✅ Checkpoint 3 — El servidor responde**
```bash
curl http://localhost:4000/health
```
Debe devolver un JSON con `"status":"ok"`. Si esto falla pero el paso 2 no mostró errores, revisa que
el puerto 4000 no esté ocupado por otra cosa.

**✅ Checkpoint 4 — Prisma/Postgres están de verdad conectados**
```bash
cd backend && npx prisma studio
```
Se abre una UI en el navegador mostrando las tablas `Token`, `FeePayment` y `Withdrawal`. Si
tira error de conexión, revisa que `DATABASE_URL` en tu `.env` coincida exactamente con
las credenciales de `docker-compose.yml`.

**✅ Checkpoint 5 — La wallet del servidor tiene fondos**
```bash
solana balance <direccion-publica-de-tu-server-wallet> --url devnet
```
Si da 0, el mint va a fallar a mitad de camino porque el servidor no puede pagar la
creación de cuentas. Vuelve al faucet.

**✅ Checkpoint 6 — Flujo completo (el que de verdad importa)**
Con backend y frontend corriendo, en el navegador:
1. Conecta Phantom en Devnet.
2. Llena el formulario con supply bajo. Para una pool USDC necesitarás USDC de Devnet; conserva SOL para fees de red y cuentas.
3. Dale a "Lanzar Token" — Phantom debe pedirte firmar.
4. Tras firmar, deberías ver el link a Solscan. Ábrelo: el token debe existir on-chain
   con el nombre/símbolo que pusiste.
5. Si marcaste algún "Revoke", verifica en Solscan → pestaña "Metadata" o el estado de
   Mint Authority — debe decir revocado/`None`.
6. Crea una pool de prueba con un aporte pequeño y revisa que Phantom muestre los dos
   activos y las cantidades esperadas antes de aprobar.
7. Para probar el swap, revisa lado, entrada, mínimo recibido, impacto y slippage en Wire;
   Phantom muestra aparte el fee de red. Luego confirma que Wire verifica y registra el swap.
8. En una pool desechable, prueba retirar la posición LP. El saldo LP de esa wallet debe
   bajar; retirar el 100% no borra la pool ni sus cuentas.

La ruta USDC necesita una creación de pool y un swap confirmados en Devnet para cerrar su
validación end-to-end. No firmes una operación si los activos, cantidades o red que muestra
Phantom no coinciden con lo que esperabas.

Si el checkpoint 6 falla pero el 1-5 pasaron, el error está en la construcción de la
transacción (revisa los logs del backend, ahí queda todo con `pino`) y no en la
infraestructura — ya descartaste esa parte.

---

## Antes de compartir o desplegar

- Mantén el flujo en Devnet hasta completar una revisión de seguridad y pruebas de
  integración con PostgreSQL, Redis, Solana RPC y Phantom. No cambies los endpoints a
  Mainnet como parte de una prueba local.
- Comprueba `GET /health/live` y `GET /health/ready`; el primero solo confirma que el
  proceso responde y el segundo valida sus dependencias externas.
- Aplica migraciones con `npx prisma migrate deploy` y revisa el historial de migraciones
  del entorno. No uses `migrate reset` para corregir divergencias.
- Configura HTTPS, CORS y secretos fuera del repositorio antes de exponer la aplicación.
  `SERVER_WALLET_PRIVATE_KEY` nunca debe subirse a Git ni contener fondos de usuarios.
- Revisa las comisiones y los resultados estimados contra la transacción confirmada antes
  de presentar cifras como resultados reales.

---

## Estructura del proyecto

```
launchpad/
├── docker-compose.yml       # Postgres + Redis
├── backend/
│   ├── src/
│   │   ├── controllers/     # Lógica de los endpoints HTTP
│   │   ├── services/        # IPFS, mint, Raydium CPMM, swaps y retiros
│   │   ├── routes/
│   │   └── utils/           # config, logger, prisma, conexión Solana
│   └── prisma/schema.prisma
└── frontend/
    ├── app/                 # Next.js App Router
    └── components/          # Wallet provider
```
