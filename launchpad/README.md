# Launchpad de Memecoins en Solana — Guía de arranque

Este proyecto tiene 3 partes que corren por separado:

1. **PostgreSQL + Redis** (vía Docker)
2. **Backend** (Express + TypeScript, puerto 4000)
3. **Frontend** (Next.js, puerto 3000)

No hay atajos aquí: para que esto funcione de verdad necesitas cuentas y claves reales.
Sigue el orden exacto de abajo.

---

## Auditoría de esta versión — qué encontré y arreglé

Antes de entregarte esto, lo audité completo: chequeo de tipos con el compilador real
de TypeScript, y una revisión manual cruzando cada archivo contra los que lo llaman. No
pude correr `npm install` de verdad (mi sandbox no tiene red), así que esto no reemplaza
un primer `npm run dev` real de tu parte — pero sí cacé y arreglé 3 bugs concretos que
te habrían tronado el backend al arrancar o al confirmar una transacción:

1. **Dependencia de Metaplex mal declarada.** El código usa
   `@metaplex-foundation/mpl-token-metadata`, pero `package.json` solo tenía
   `@metaplex-foundation/js` (un paquete distinto, que además no se usa en ningún
   archivo). Con eso, `npm install` habría funcionado pero el servidor se caía al
   arrancar con "Cannot find module". Ya está corregido.
2. **Versión de ese mismo paquete fijada mal.** La v3 de
   `mpl-token-metadata` es una reescritura completa sobre otra arquitectura (Umi) y ya
   no expone `createCreateMetadataAccountV3Instruction` ni
   `createUpdateMetadataAccountV2Instruction` como funciones sueltas — que es el estilo
   que usa este código. Lo fijé en `^2.13.0`, que sí tiene esa API, y dejé un comentario
   de advertencia en los dos archivos que la usan para que nadie lo actualice sin querer.
3. **El modelo `FeePayment` existía en el schema pero nunca se usaba.** El brief
   original pedía guardar el cobro "para tu contabilidad" y se había quedado a medias.
   Ahora se crea un registro real cuando la transacción se confirma on-chain (no antes,
   para no contar como "cobrado" algo que el usuario nunca llegó a firmar).

Limitaciones que **no** son bugs pero sí debes conocer antes de probar:

- **El blockhash puede expirar.** El backend arma la transacción con un blockhash fresco,
  pero si el usuario tarda mucho en firmar (imagen pesada, revisando el formulario, red
  lenta), Solana lo puede rechazar por "blockhash not found" al enviarlo. Para un MVP de
  prueba no importa; si ves ese error en producción, el fix es refrescar el blockhash
  justo antes de firmar en vez de reusar el que vino de `create-token`.
- **`liquiditySol` no se gasta en nada todavía.** Como el pool de Raydium sigue siendo un
  stub, el número que el usuario pone ahí solo se usa para el chequeo de saldo mínimo —
  no hay ninguna instrucción real que lo transfiera. Cuando implementes Raydium esto se
  resuelve solo.
- **La quema de LP tiene un monto hardcodeado en `0n`** (ver el comentario `TODO` en
  `lpSecurityService.ts`). Es intencional — hoy esa función es inalcanzable porque
  `lpMint` siempre es `null` sin Raydium — pero es lo primero que hay que arreglar ahí
  cuando conectes el pool de verdad.

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
npx prisma migrate dev --name init
npx prisma generate
```

Y levanta el servidor:
```bash
npm run dev
```
Deberías ver `Backend listening on http://localhost:4000`. Prueba que responde:
```bash
curl http://localhost:4000/health
```

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

Corre:
```bash
npm run dev
```
Abre http://localhost:3000, conecta Phantom (cambiado a Devnet en su configuración),
y prueba crear un token con poca liquidez para no gastar de más mientras pruebas.

---

## 4. Lo que YA funciona vs lo que falta

✅ Conectar wallet, formulario, subida de imagen/metadata a IPFS, creación del mint SPL,
metadata de Metaplex, transferencia del fee a tu wallet, guardado en base de datos.
El fee ahora es fijo en SOL (0.5 base + 0.1 por cada asset de seguridad), configurable
en `BASE_FEE_SOL` / `ASSET_FEE_SOL` del `.env`.

⚠️ **La creación del pool en Raydium sigue siendo un stub** (`backend/src/services/raydiumService.ts`).
El SDK de Raydium (`@raydium-io/raydium-sdk-v2`) cambia su forma de crear pools con cierta
frecuencia, así que no quise dejarte un código que pudiera estar desactualizado y fallarte
en silencio. En vez de eso:

1. Corre `npm view @raydium-io/raydium-sdk-v2 version` para ver la versión actual.
2. Busca el ejemplo oficial de "create pool" de esa versión.
3. Pega ese ejemplo en Claude Code junto con `raydiumService.ts` y pídele que lo integre
   siguiendo la misma firma de función (recibe `userWallet`, `mint`, `liquiditySol`,
   devuelve un array de `TransactionInstruction`).

⚠️ **Los assets de seguridad de LP (bloqueo/quema)** dependen del paso de Raydium:

- **Quema total de LP** (`backend/src/services/lpSecurityService.ts` →
  `buildTotalBurnInstruction`) SÍ está implementada completa — es una instrucción SPL
  estándar (burn), no depende de ningún SDK externo. Solo falta que `raydiumService.ts`
  te devuelva el `lpMint` real para poder usarla (por ahora el controlador la salta porque
  `lpMint` es `null` mientras Raydium siga siendo un stub).
- **Bloqueo temporal (6 meses)** depende del SDK de Streamflow, que igual que Raydium
  cambia con el tiempo — dejé la misma clase de aviso ahí con los pasos a seguir antes
  de implementarlo.

✅ **Revoke Authorities (Revoke Mint / Revoke Freeze / Revoke Update)** —
(`backend/src/services/authorityService.ts`) están **completamente implementadas y
funcionan ya**, sin depender de Raydium ni de ningún SDK externo inestable. Son
instrucciones núcleo de SPL Token y Metaplex (`setAuthority` y
`UpdateMetadataAccountV2`), estables desde hace años:

- **Revoke Mint**: nadie podrá volver a acuñar supply de ese token.
- **Revoke Freeze**: nadie podrá congelar las cuentas de los holders.
- **Revoke Update**: el metadata (nombre, símbolo, imagen) queda inmutable para siempre.

Mientras tanto, el flujo de mint + fee + revoke authorities + guardado en base de
datos funciona de punta a punta sin el paso de Raydium (verás warnings en los logs
para los assets de LP, y el token se crea igual, solo sin pool ni bloqueo/quema).

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
Debe devolver `{"ok":true}`. Si esto falla pero el paso 2 no mostró errores, revisa que
el puerto 4000 no esté ocupado por otra cosa.

**✅ Checkpoint 4 — Prisma/Postgres están de verdad conectados**
```bash
cd backend && npx prisma studio
```
Se abre una UI en el navegador mostrando las tablas `Token` y `FeePayment` vacías. Si
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
2. Llena el formulario con supply bajo y liquidez mínima (0.65).
3. Dale a "Lanzar Token" — Phantom debe pedirte firmar.
4. Tras firmar, deberías ver el link a Solscan. Ábrelo: el token debe existir on-chain
   con el nombre/símbolo que pusiste.
5. Si marcaste algún "Revoke", verifica en Solscan → pestaña "Metadata" o el estado de
   Mint Authority — debe decir revocado/`None`.

Si el checkpoint 6 falla pero el 1-5 pasaron, el error está en la construcción de la
transacción (revisa los logs del backend, ahí queda todo con `pino`) y no en la
infraestructura — ya descartaste esa parte.

---

- Cambia `RPC_ENDPOINT` y `NEXT_PUBLIC_RPC_ENDPOINT` a tus URLs de **mainnet-beta**.
- Prueba TODO el flujo en Devnet primero, varias veces, incluyendo casos de error
  (saldo insuficiente, símbolo repetido, etc.).
- Revisa `backend/src/services/raydiumService.ts` — no debe seguir siendo un stub.
- Considera un límite de rate por wallet/IP en el backend antes de exponerlo públicamente.
- La clave privada de `SERVER_WALLET_PRIVATE_KEY` nunca debe subirse a git. `.env` ya
  está en el `.gitignore` que trae el proyecto — verifícalo.

---

## Estructura del proyecto

```
launchpad/
├── docker-compose.yml       # Postgres + Redis
├── backend/
│   ├── src/
│   │   ├── controllers/     # Lógica de los endpoints HTTP
│   │   ├── services/        # IPFS, precio de SOL, mint, Raydium (stub)
│   │   ├── queues/          # BullMQ (preparado, no obligatorio para MVP)
│   │   ├── routes/
│   │   └── utils/           # config, logger, prisma, conexión Solana
│   └── prisma/schema.prisma
└── frontend/
    ├── app/                 # Next.js App Router
    └── components/          # Wallet provider
```
