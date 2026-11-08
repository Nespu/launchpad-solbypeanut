# Wire — handoff actualizado para Claude

**Fecha:** 2026-11-07
**Fuente:** estado local actual de Wire, compartido en la rama de revisión de este repositorio. La rama principal no se modificó.

## Progreso del proyecto

**70.95%** en **37 hitos**. Conteo por estado: blocked: 2, complete: 9, in_progress: 8, pending: 3, ready_for_validation: 15.

Cálculo del tracker: hitos completos = 100%; listos para validación = 80%; en progreso = el porcentaje guardado en el hito; pendientes o bloqueados = 0%. El porcentaje mide avance del roadmap, no reemplaza las validaciones de Devnet.

## Todo lo que falta o requiere validación

- **Lista para validación · 80%:** Crear tokens en Pump.fun Devnet
- **Bloqueada · 0%:** Cerrar el caso de la pool antigua que no aparece en Devnet
- **Lista para validación · 80%:** Acciones de seguridad de liquidez: quemar LP o bloquearlos temporalmente
- **Lista para validación · 80%:** Balances SOL/SPL y seguimiento de direcciones públicas
- **Lista para validación · 80%:** Token Disperse con lotes revisables y firma local
- **En progreso · 98%:** Token Sender: destinatarios nuevos, asignación por supply y financiación opcional
- **Lista para validación · 80%:** Consultar pools y retirar LP con la wallet creadora elegida de la bóveda
- **Lista para validación · 80%:** Compras secuenciales multiwallet, pausas y revisión antes de cada firma
- **Lista para validación · 80%:** Comprar y vender en bonding curves de Pump.fun
- **Lista para validación · 80%:** Detectar graduación y enrutar swaps a PumpSwap
- **En progreso · 68%:** Validar importación de swaps de AMM V4, Stable AMM y CLMM
- **Pendiente · 0%:** Fast Bundle atómico y Fast Bundle + Timed Buys
- **En progreso · 75%:** Timed Buys por lanzamiento, Snipe, Retry, Smart Sell/Auto TP y buy tasks
- **Lista para validación · 80%:** Importar y verificar swaps externos de mercados compatibles
- **En progreso · 95%:** PnL realizado FIFO y aviso cuando el historial está incompleto
- **En progreso · 55%:** PnL completo con actividad externa, transferencias, liquidez y precios verificables
- **Pendiente · 0%:** Leaders y ranking con métricas, periodo y controles contra manipulación
- **Lista para validación · 80%:** Lanzamientos por lote con revisión y firma individual
- **Pendiente · 0%:** Bump Bot y market maker con actividad identificable y límites
- **Lista para validación · 80%:** Consultar y retirar creator fees de Pump.fun y PumpSwap
- **Lista para validación · 80%:** Configurar y distribuir creator fees entre varios destinatarios
- **Lista para validación · 80%:** Selección y explicación de Holder Rewards en Pump.fun
- **Lista para validación · 80%:** Seguimiento del mercado tras crear el token
- **En progreso · 17%:** Catálogo y ciclo de vida de tareas Svarog/Vortex para Solana
- **En progreso · 55%:** Revisión visual de escritorio y móvil para operaciones densas
- **Lista para validación · 80%:** Pruebas firmadas de USDC, Token Disperse, Pump.fun y PumpSwap
- **Bloqueada · 0%:** Confirmar el importador Stable AMM con una pool real de Devnet
- **En progreso · 62%:** Completar documentación, páginas legales y canales de soporte

## Contexto para la revisión

- Wire es un launchpad y suite de operaciones de Solana. La rama de revisión incluye el código y los documentos de roadmap actuales; el remoto y los handoffs antiguos pueden estar desactualizados.
- El usuario pidió conservar el alcance completo inspirado en Svarog/Vortex. No descartes funciones de forma unilateral: identifica riesgos y propone variantes transparentes y controles. No diseñes volumen falso ni ocultes relaciones entre wallets.
- Una incidencia concreta que conviene revisar en paralelo es el cambio de cuenta de Phantom: el selector permite elegir otra cuenta, pero Wire acaba usando la cuenta activa anterior. Revisa rontend/components/SolanaProviders.tsx, rontend/components/LocalizedWalletModalProvider.tsx, rontend/components/WalletIdentityProvider.tsx y rontend/lib/walletAdapterNames.ts. Devuelve hipótesis y un diff mínimo sugerido en la conversación; Codex aplicará y verificará los cambios localmente.
- No se han compartido claves privadas ni configuración .env. La app permanece enfocada en Devnet; cualquier firma y transacción real requiere revisión y aprobación explícitas del usuario.
- Esta rama es para leer y debatir. No hagas push, reset ni rebase. No tomes este documento como permiso para firmar transacciones o ejecutar operaciones con wallets.

## Reparto de trabajo propuesto

Claude: revisar de forma acotada la propagación del cambio de cuenta de Phantom, señalar riesgos de carrera/estado obsoleto y sugerir un parche pequeño. Codex: avanzar otro hito del roadmap local y aplicar la recomendación solo tras revisar el diff.
