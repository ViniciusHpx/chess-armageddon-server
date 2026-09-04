# CLAUDE.md

Orientação para o Claude Code (claude.ai/code) trabalhando neste repositório.

## Visão geral

Servidor **autoritativo** da arena multiplayer de
[Chess Armageddon](../chess-armageddon), em **Colyseus 0.17** + TypeScript ESM.
Roda a 20 ticks/s: posição, colisão, dano, morte, XP, promoção, aura, dash e os
bots nascem todos aqui. O cliente Phaser, no modo online, **não simula nada** —
manda entrada e desenha o estado que volta.

Os dois repositórios são irmãos e ficam lado a lado
(`../chess-armageddon` / `../chess-armageddon-server`). O cliente tem o próprio
`CLAUDE.md`, muito mais longo, com o detalhe de cada mecânica e o **modo
offline** (`?offline=1`), que é o jogo inteiro no navegador e não passa por aqui.
Mexeu em regra de jogo? Leia os dois.

## Comandos

```bash
npm run dev        # tsx watch src/index.ts — é ISTO que se usa para desenvolver
npm start          # node build/index.js — exige `npm run build` antes
npm test           # mocha + tsx, lê o FONTE: 104 passando, 13 pendentes
npm run typecheck  # tsc --noEmit
npm run build      # tsc -p tsconfig.build.json -> build/ (gitignored)
npm run loadtest   # clientes sintéticos, TUI interativa (8 clientes)

npm run sync:mask      # copia a máscara de colisão do cliente para assets/
npm run paint:water    # pinta a água na máscara — NÃO é idempotente
npm run paint:bridges  # pinta as pontes na máscara — idempotente
```

### `npm start` roda `build/`, não `src/`

É a armadilha nº 1 deste repositório, e o sintoma é traiçoeiro: o servidor sobe,
aceita conexão e joga normalmente — **com o código antigo**. A mensagem nova
simplesmente não faz nada, e não há erro em lugar nenhum.

`npm test` e `npm run typecheck` leem o fonte (`tsx`, `--noEmit`), então **passar
nos dois não garante que o que está no ar é aquilo**. `build/` é gitignored, ou
seja, uma checagem de `git status` também não avisa.

Use `npm run dev` para desenvolver. Se precisar do `npm start`, rode
`npm run build` antes.

### Servir o cliente junto

```bash
cd ../chess-armageddon
python -m http.server 8000   # ou: npx http-server -p 8000 -c-1
```

| URL | O quê |
| --- | --- |
| `http://localhost:8000` | jogo online (padrão) |
| `http://localhost:8000/?offline=1` | jogo local, sem servidor |
| `http://localhost:8000/?server=wss://...` | aponta para outro servidor |
| `http://localhost:2567/health` | `{ok:true}` |
| `http://localhost:2567/` | playground do Colyseus (só fora de produção) |
| `http://localhost:2567/monitor` | painel — exige `MONITOR_PASSWORD` |

O cliente aponta para produção por padrão
(`SERVER_ENDPOINT` em `../chess-armageddon/src/net/netconfig.js`), então para
testar contra o servidor local use `?server=ws://localhost:2567`.

## Arquitetura

```
src/
  index.ts                  entrada — NÃO editar (exigência da Colyseus Cloud)
  app.config.ts             rotas express, monitor protegido, playground,
                            LobbyRoom, e o load da máscara ANTES de aceitar conexão
  rooms/
    ArenaRoom.ts            traduz mensagens <-> World e copia para o schema
    schema/ArenaState.ts    o que trafega na rede
  sim/                      SIMULAÇÃO — nada de Colyseus aqui dentro
    constants.ts            FONTE DE VERDADE (RANKS, mundo, combate, dash, IA)
    Actor.ts                personagem headless
    World.ts                o tick: entrada -> IA -> física -> golpes
    CollisionMask.ts        máscara do cenário (PNG -> bitset)
    NavGrid.ts              malha de navegação dos bots + A*
    CollisionResolver.ts    separação pelas elipses
    geometry.ts             testes forma-contra-elipse
    mathx.ts                substitutos de Phaser.Math
scripts/                    passos de ASSET, rodados à mão
test/                       World.test.ts (simulação) e ArenaRoom.test.ts (sala)
assets/collision.png        cópia VERSIONADA da máscara (ver mais abaixo)
loadtest/example.ts         cenário do @colyseus/loadtest
ecosystem.config.cjs        PM2 (um processo por CPU) para a Colyseus Cloud
_smoke.mjs                  teste manual de conexão contra produção
```

**`sim/` não importa Colyseus nem Phaser.** É isso que deixa a simulação
testável em milissegundos — `test/World.test.ts` roda mais de 90 cenários de
combate, colisão e navegação sem abrir socket nenhum — e o que permitiria rodá-la
em outro transporte. Não quebre essa fronteira: se algo precisa da sala (relógio
do Colyseus, `broadcast`, `matchMaker`), ele mora na `ArenaRoom`.

O `World` também não conhece modos de jogo. Ele recebe `killLimit` (um número) e
a sala decide esse número a partir do modo.

### O tick (`World.tick`)

Na ordem exata, espelhando o `update` + `postupdate` da cena original:

0. **partida decidida → `return` antes de tudo**, inclusive do relógio. A
   simulação inteira congela enquanto a tela de resultado está no ar;
1. `stepPlayer` / `stepBot` — entrada e IA definem `vx`/`vy`;
2. integra `(vx + knockbackVx) * dt` via `moveWithCollision`, e decai o empurrão;
3. `resolveCollisions` — separa quem se sobrepõe;
4. por ator: cancela dash que esbarrou em alguém → `clampToWorld` → pousa a
   travessia do cavalo → **revalida** contra `lastValidX/Y`;
5. aplica os golpes cujo windup venceu;
6. renasce os bots (humanos esperam o botão RENASCER);
7. `healInBase`.

O passo 4 é o mais delicado. A **revalidação** existe porque a separação entre
personagens e o clamp da borda escrevem posição direto, sem passar pelo
`resolveMove`: sem ela dava para prensar um jogador contra a muralha e passar por
ela, e para subir no meio da ponte sendo empurrado por um aliado. Posição
reprovada volta para `lastValidX/Y`.

`Actor.teleport()` é o jeito de reposicionar sem brigar com essa rede — ele move
**e** atualiza `lastValid*`. Escrever `x`/`y` na mão faz o ator ser devolvido no
tick seguinte. Spawn, respawn, `debugCycleRank` e os testes usam `teleport`.

O patch de estado sai na mesma cadência (`setPatchRate(TICK_MS)`).

## Protocolo

Cliente → servidor. Nomes curtos porque vão a 20 Hz:

| Tipo | Carga | O quê |
| --- | --- | --- |
| `i` | `{dx, dy, s, ax, ay}` | vetor de movimento + sequência do pacote + MIRA do ataque |
| `a` | `1` \| `0` | apertou / soltou o controle de ataque |
| `d` | — | pediu dash |
| `r` | — | pediu para renascer |
| `dbg` | — | DEBUG: avança a peça no ciclo |
| `rm` | — | aceitou a revanche |

Servidor → cliente: o `state` (schema) e a mensagem `kill` `{killer, victim}`.

**Quatro das seis mensagens são sem corpo, de propósito.** `d`, `r`, `dbg` e `rm`
só dizem *apertei*; direção, distância, cooldown, qual peça vem a seguir e qual
sala é a revanche são decisão do servidor. Não há nada que o cliente possa
inflar, e spam cai no `return` do cooldown (e, em rajada, no
`maxMessagesPerSecond = 60` da sala).

### O que o servidor não aceita do cliente

- **módulo do vetor de movimento** — `World.setInput` normaliza e clampa; mandar
  `dx: 999` anda igual a `dx: 1`;
- **módulo do vetor de mira** — normalizado pelo mesmo `setInput` (não clampado
  eixo a eixo, que GIRARIA a mira), e vetor não finito vira neutro. Só a direção
  é usada: mira gigante não vira alcance;
- **mira já usada** — uma direção vale por UM golpe. `beginAttack` a consome e
  fecha o `aimReady`; enquanto ele estiver fechado, mira fora da zona morta é
  ignorada. Reabre quando chega um pacote com o controle centrado. Cliente que
  insista no mesmo arraste não bate na mesma direção de novo — bate sem direção
  nenhuma, no ritmo do `ATTACK_INTERVAL`;
- **sequência velha** — pacote com `s <= inputSeq` tem o vetor ignorado, mas
  ainda conta como sinal de vida (senão `INPUT_TIMEOUT_MS` mataria o movimento);
- **"meu golpe foi carregado"** — quem cronometra é `World.releaseAttack`, com o
  relógio da sala, e o clamp mora dentro de `chargePower()`;
- **posição, dano, XP, nível, rank** — não existe mensagem para nada disso;
- **`bots` e `mode` na criação** — `sanitizeBots` (0..`TEAM_SIZE`) e
  `sanitizeGameMode` (allowlist estrita) tratam string, fração, negativo, `NaN`,
  objeto e ausente. Valor estranho não é erro fatal: vira o padrão;
- **nome** — `sanitizeName` corta controles C0/DEL e limita a 16 caracteres. O
  mesmo 16 aparece em três lugares no cliente (ver o `CLAUDE.md` de lá).

## Sala, lobby e bots

| Onde | O quê |
| --- | --- |
| `LobbyRoom` (nativa, em `app.config.ts`) | lista as salas e empurra `rooms`/`+`/`-` |
| `ArenaRoom.publish()` | `setMetadata` + `lock()`/`unlock()` + `updateLobby()` |
| `ArenaRoom.onCreate(options)` | sanea `bots`/`mode` e cria os bots |

**Sem polling.** Quem dispara a atualização da lista é a própria `ArenaRoom`, ao
criar, ao alguém entrar, ao alguém sair e ao a partida acabar.

**Slots.** `TEAM_SIZE` (5) por time. Quem cria escolhe quantos nascem bot; o
resto fica vago. Entrando um humano: **slot vazio primeiro**, e só se o time
estiver completo é que um bot cede o lugar (`World.findBot`, o primeiro achado).
Sem slot e sem bot → `ServerError(4001)`.

`pickTeam()` escolhe entre os times **com vaga** o de menos humanos, desempatando
pelo de menos ocupantes. É daí que sai de graça o "o segundo jogador cai no time
oposto" da revanche — não existe regra de dois jogadores em lugar nenhum.

**Corrida pelo último slot:** `onJoin` roda uma vez por vez na sala, então o
segundo pedido já enxerga o slot ocupado e é recusado. Coberto por teste.

**Sem `WAITING`/`PLAYING`.** A arena é deathmatch contínuo; a simulação roda
desde o `onCreate`. Um campo de status seria estado redundante — mais um jeito de
divergir do `World`. O que importa é "aceita gente?", e isso é o `lock()` nativo.

**`autoDispose` liga e desliga.** O campo nasce `true`, mas o `onCreate` o
desliga e um `clock.setTimeout` o devolve depois de `ROOM_JOIN_GRACE_SECONDS`
(90 s); `onJoin` religa na hora. Motivo: sala criada e vazia se descarta em 15 s
(`seatReservationTimeout`), menos do que leva recarregar Phaser e a arte na
revanche. Sem essa carência a revanche morria antes de o jogador chegar — e o
sintoma engana (ver *Erros que parecem CORS*).

**Saída.** `CloseCode.CONSENTED` (botão MENU, revanche, fechar a aba) remove na
hora. Queda de rede congela o ator (`frozen`) por `RECONNECTION_SECONDS` (20 s);
expirada a janela, `dropPlayer` remove e **repõe um bot só até `botsPerTeam`** —
sala criada com 0 bots nunca ganha bots.

### Modos de jogo

`GAME_MODES = ["team_deathmatch", "capture_the_flag", "free_for_all"]`.

Hoje o modo é só um **rótulo**: nenhuma regra depende dele, exceto a condição de
vitória. Ele existe para a escolha ficar registrada, aparecer no lobby e dar onde
pendurar as regras depois. A **ordem da lista é contrato de rede** (trafega como
índice em `ArenaState.mode`) — modo novo entra no FIM.

### Fim de partida e revanche

Só o `team_deathmatch` tem vitória: a sala repassa `TEAM_KILL_LIMIT` (40) ao
`World.killLimit`; nos outros modos ele fica em 0 (arena sem fim).

O placar é do **time**, não somado dos atores: `World.teamKills` é incrementado
em `registerTeamKill`, no mesmo ponto do abate, então sobrevive à saída de quem
matou. Batido o limite, `World.winner` é escrito ali mesmo — placar e resultado
não têm como discordar.

A sala espelha em `ArenaState` (`scoreAlly`, `scoreEnemy`, `winner` como índice
em `TEAM_ORDER`, `-1` = em curso), trava e recusa entrada (`ServerError(4002)`).
O cliente **não decide nada**: mostra a tela de resultado por causa de `winner`.

**Revanche:** o cliente manda `"rm"`; a sala nova é criada **uma vez por
partida**, com os mesmos bots e o mesmo modo. A trava `rematchCriando` existe
porque `matchMaker.createRoom` é assíncrono — sem ela, dois cliques no mesmo
instante criariam duas salas. O id vai para `state.rematchRoomId`, que todos
recebem, e quem aceitar depois entra na mesma sala.

## Contratos com o cliente

`src/sim/constants.ts` é a **fonte de verdade**;
`../chess-armageddon/src/constants/Hierarchy.js` é a cópia de desenho. Mudou um
valor aqui, espelhe lá. Quatro coisas quebram de formas silenciosas:

1. **`RANK_ORDER`** — define o `uint8` que trafega. Mudar a ordem de um lado só
   troca a peça de todo mundo.
2. **`TEAM_INDEX`** (`TEAM_ORDER` lá) — inverter de um lado só troca a **cor** de
   todos os personagens.
3. **`GAME_MODES`** — idem, para o rótulo do modo.
4. **A fórmula do centro da elipse** — `Actor.ellipseCenter()` aqui e
   `ArenaActor.getEllipseCenter()` lá. Ela reproduz o `body.center` do Arcade sem
   haver corpo: `centerY = y + altura/2 - collisionRx + collisionRy * 4/3`.
   Divergir faz o golpe acertar fora do que aparece na tela.

Além disso: `CHARGED_ATTACK_ENABLED`, `WATER_SPEED_FACTOR`, `movementFactor()`,
`DASH_DISTANCE`/`DASH_DURATION_MS`, `knockbackSpeed()` e `canPhaseDash()` são
espelhados — é com eles que a **previsão local** do cliente anda. Um valor
diferente de um lado só aparece como o boneco sendo puxado para trás.

O golpe trafega como `ActorState.atkPower` (uint8, 0..100): é a potência **já
decidida pelo servidor**, não o tempo de carga. Se cada lado recalculasse a
partir do tempo, os arredondamentos divergiriam.

A direção do golpe trafega como `ActorState.atkAngle` (float32, radianos): é o
ângulo JÁ decidido aqui, não o vetor de mira nem um índice de direção — ver
*Direção do golpe: contínua, sem quantização*.

**Forma de ataque nova exige quatro funções em sincronia**, duas de cada lado:
`attackShapes()` (o layout, em `sim/geometry.ts` aqui e em
`utils/AttackGeometry.js` lá — o desenho do cliente e o dano daqui saem da MESMA
função, não há mais `switch` paralelo por lado) e `attackReach()` (o alcance com
que a IA decide atacar, em `constants.ts` e em `Hierarchy.js`). Esquecer o
alcance não quebra o golpe — só faz o bot atacar cedo ou tarde demais.
`attackHalfBand()` continua existindo nos dois lados como descrição da forma (e
é testada aqui), mas saiu da decisão da IA: com o bot mirando NO alvo, o desvio
perpendicular é zero e a faixa passaria sempre.

### Uma mira, um golpe

Não existe ataque contínuo. Segurar o botão não repete golpe nenhum: o
`stepPlayer` tinha um `startCharge` por tick enquanto `attackHeld` estivesse de
pé, e ele saiu. Hoje cada golpe nasce de uma mensagem `"a" 1`.

A garantia do servidor não depende do cliente e é a mesma para jogador e bot:

1. `beginAttack` **consome a mira** (`aimDx`/`aimDy` zerados) e fecha
   `Actor.aimReady`;
2. `setInput` só aceita direção nova com `aimReady` aberto, e ele só reabre com
   um pacote reportando a mira dentro de `ATTACK_AIM_DEADZONE` — o controle de
   volta ao centro;
3. o bot decide de novo em `aimAt`, imediatamente antes de cada golpe (e antes
   de soltar a carga). Como a mira foi zerada, bot que não decidisse bateria sem
   direção — não há como reaproveitar a anterior.

`attackHeld` continua no `Actor` como relato de entrada (o `INPUT_TIMEOUT_MS` o
derruba, `kill` o limpa), mas não dispara mais nada.

### Direção do golpe: contínua, sem quantização

A direção do golpe é o **ângulo do vetor de mira**, contínua em 360°. Já foi
encaixe em oito direções (múltiplos de 45°) e, antes, só o `flipX`.

O cliente manda a mira crua (`ax`/`ay` no `"i"`); quem converte vetor em ângulo
é `attackAimAngle` (em `constants.ts`, espelhada em `Hierarchy.js`), que aplica
a `ATTACK_AIM_DEADZONE` e o fallback do `flipX`. `beginAttack` congela o
resultado em `Actor.atkAngle`, e ele vai para o cliente em
`ActorState.atkAngle` (**float32, radianos**) — o desenho usa o mesmo número que
gerou o dano, como já era com `atkPower`. Trafegar um índice de direção seria
reintroduzir a quantização.

**Os bots usam o mesmo caminho**: `World.aimAt` preenche o `aimDx`/`aimDy` do
próprio ator, mirando no centro da elipse do alvo, imediatamente antes de
`beginAttack` (e de novo antes de soltar a carga, porque o alvo andou). Antes
nenhum bot escrevia mira e todos caíam no `flipX`: só leste e oeste.

`botCanHit` passou a medir o alcance **na direção do golpe** (`ellipseRadiusAt`
em vez do raio em X) e perdeu o teste de faixa lateral: mirando no alvo, o
desvio perpendicular é zero e `attackHalfBand` passaria sempre.

### Ataque carregado está DESLIGADO

`CHARGED_ATTACK_ENABLED = false`, e o cliente tem de ter o mesmo valor. Com a
flag desligada, apertar o botão já sai como golpe leve (potência 0) e ninguém
entra em estado de carga: `World.startCharge` chama `beginAttack(actor, 0)` e
`botShouldCharge` devolve `false`.

**Nada foi removido.** Toda a máquina da carga (`chargePower`, `chargeDamage`,
`chargeAreaMult`, `attackWindupMs`, `attackRecoveryMs`, `stepBotCharge`) está no
lugar, e os testes de carga continuam escritos — eles pulam sozinhos via
`itCarregado`. Voltar a flag para `true` **nos dois lados** reativa tudo.

## Máscara de colisão

`sim/CollisionMask.ts` decodifica o PNG **uma vez por processo** (pngjs) e o
transforma em três bitsets — caminhável, água, ponte —, ~512 KB para os
2496×1684 da metade. Nenhum tick abre arquivo, decodifica imagem ou varre o mapa.
`NavGrid` também é instância única (`NavGrid.shared`).

**O asset é a METADE esquerda** (2496×1684); o mundo é essa metade mais o espelho
dela em X, daí `WORLD_WIDTH = HALF_WORLD_WIDTH * 2` e a conta
`px >= halfWidth → width - 1 - px`.

### Onde o arquivo é procurado — e o nome muda na cópia

`CANDIDATOS`, em ordem:

1. `process.env.COLLISION_MASK_PATH`;
2. `assets/collision.png` — a cópia versionada, **a única que existe no deploy**;
3. `../chess-armageddon/assets/collision.png` — fallback de desenvolvimento.

⚠️ **O nome muda entre os dois lados.** No cliente o arquivo é
`assets/arena_collision.png` (`COLLISION_PATH` em `Scenario.js`); `sync:mask` lê
esse nome do próprio `Scenario.js` e grava aqui **sempre como
`assets/collision.png`**. Consequência: o candidato 3 está morto — se
`assets/collision.png` faltar, o fallback não acha nada e o servidor não sobe.
Não é um problema em si (o candidato 2 existe e é versionado), mas não confie no
fallback e não "corrija" um dos lados sem olhar o outro.

`sync:mask` **falha** (exit 1) se não achar `COLLISION_PATH` ou a origem. Antes o
caminho estava escrito à mão no script: a arte foi renomeada, o script passou a
avisar e sair com **sucesso**, e a cópia do servidor congelou numa versão antiga.
Os dois lados ficaram colidindo contra mapas diferentes — pouco para se notar
andando, o bastante para discordarem sobre atravessar uma parede.

**A cópia é versionada de propósito** (28 KB): cliente e servidor têm deploys
separados e, no host do servidor, a pasta do cliente não existe. Deixá-la fora do
git foi o que derrubou a criação de salas em produção.

A máscara é carregada em `app.config.ts`, **antes de o servidor aceitar
conexões**: faltando o arquivo (ou com tamanho diferente do esperado) ele não
sobe, e o log diz onde procurou.

### Quatro classes de terreno, pela cor do pixel

| Cor | Terreno | Regra |
| --- | --- | --- |
| branco (`r > 128`) | chão | velocidade cheia |
| azul (`b > 128`, `r <= 128`) | água | caminhável, `WATER_SPEED_FACTOR` (0,8) |
| vermelho (`r > 128`, `g <= 128`) | tabuleiro da ponte | chão, velocidade cheia; só não se entra vindo da água |
| preto | parede | não se anda |

O vermelho tem `r > 128` de propósito: para quem só pergunta "dá para andar?",
ponte é chão — a máscara nova responde igual à antiga. O limiar (em vez de "é
preto?") perdoa o anti-aliasing da borda.

**A regra da ponte é UMA transição proibida: água <-> ponte**, nos dois sentidos.
Mora em `canCross` e é o parapeito. Continuam livres terra <-> ponte (a
cabeceira), terra <-> água (qualquer margem) e cada classe consigo mesma. Quem já
está no tabuleiro segue e sai pelo outro lado: a regra impede **entrar**, não
passar.

Três decisões que evitam os problemas que a ideia costuma trazer:

- **quem responde é o centro da elipse**, o mesmo ponto de `isWater` — não as
  nove sondas do corpo. Assim o corpo encosta na ponte sem o passo ser recusado e
  ninguém fica entalado na borda;
- **entra no `resolveMove`** (via o privado `aceita`), o funil por onde passa
  **todo** movimento: jogador, bot, empurrão de golpe, dash e a correção da
  reconciliação. Não existe caminho de movimento que escape dele, então a regra
  não é repetida em lugar nenhum;
- **a ponte não é água**, então `isWater` é `false` ali e a velocidade é cheia.

O que NÃO passa pelo `resolveMove` é a separação entre personagens e o clamp — e
é por isso que existe a revalidação do passo 4 do tick (`posicaoAceita`).

### Resolução do movimento

- **`canStand`** — nove pontos: centro, quatro pontas e quatro diagonais da
  elipse, a 70% dos raios. As diagonais não são luxo: com só as pontas, uma quina
  entra pelo vão entre elas e o ombro do corpo termina dentro da pedra.
- **`resolveMove`** — três candidatos (diagonal, deslizar em X, deslizar em Y),
  cada um levado até **encostar** por bisseção (`maxAlong`, 4 cortes: para a menos
  de 1 px da parede). Vence o que rende mais deslocamento. O destino diagonal é
  testado como um ponto único, então uma quina nunca vira passagem.
- **`slideAround`** — se nenhum dos três sair do lugar, o passo é girado em
  `SLIDE_ANGLES` (30° e 60°) para os dois lados, mantendo o tamanho, e vence o que
  mais avança na direção pedida. Contra uma borda INCLINADA quem anda num eixo
  puro (tecla é eixo puro) ficava com os três zerados e parava seco tendo a
  superfície livre ao lado. Contra parede reta de frente os giros também batem
  nela — deslizar só acontece quando há superfície para deslizar.
- **`nearestFree`** — **última linha, não caminho normal.** Espiral curta (até
  96 px, passos de **2 px**) para quando a posição de PARTIDA já é inválida
  (separação, empurrão, clamp). Sem isso a bisseção parte de um ponto ruim e o
  personagem *desliza dentro* da muralha. O passo fino importa: com 8 px o resgate
  saltava para longe, o movimento empurrava de volta e ele disparava outra vez —
  vira tremor. Se `nearestFree` voltar a aparecer no caminho comum, é sinal de que
  a colisão travou em algum lugar; o teste da travessia do rio falha justamente
  nisso.

A posição inválida **nunca é aceita** — não existe "andou e voltou", que
produziria teleporte e jitter.

### Os scripts de asset

São passos **manuais**, não de execução. O resultado é revisável no editor de
imagem e vai versionado. Os dois leem o nome do arquivo do `Scenario.js` do
cliente e escrevem **no asset do cliente** — depois é `sync:mask` e commitar as
duas cópias.

| Script | Idempotente? |
| --- | --- |
| `paint:bridges` | **sim** — o vermelho volta a branco no começo e a detecção refaz tudo a partir de chão e água |
| `paint:water` | **NÃO** — cada rodada come mais uma faixa de "praia", porque a água nova cria margem nova (medido: a segunda rodada mexe em 2343 px). Rode uma vez e revise |

⚠️ O comentário de cabeçalho de `paint-water.mjs` diz que rodar de novo dá o
mesmo resultado. **Está desatualizado** — o comentário do `--only-prune`, logo
abaixo, tem a versão correta. Para corrigir só o "fundo" numa máscara já pintada
existe `node scripts/paint-water.mjs --only-prune`, que pula os passos 1 a 4: ele
só APAGA água sem contato com chão, e não tem como criar água nova.

**`paint:water`** cruza a ARTE (`arena.png`, onde rio e mar são azulados e o
terreno é amarronzado) com o que a máscara já marcava como bloqueado, em cinco
passos: componentes conexos grandes viram água (telhado azul é pequeno) → faixa
de "praia" de 24 px → respingo (bloco menor que a elipse do peão, cercado só de
água — eram 267 no rio, e eram eles que travavam quem atravessava) → e por
último **poda de fundo**: água que não encosta em chão nenhum não é água, é céu, e
volta a ser parede. O último passo roda por último de propósito: antes da praia o
rio de verdade ainda está separado do chão e seria reprovado junto.

**`paint:bridges`** acha as pontes por topologia, sem uma única coordenada
cravada: *vão* (chão com água dos dois lados a menos de 160 px, medido sem
atravessar parede) e *corte* (dos candidatos, sobram só os que ligam duas massas
de terra distintas). Nesta máscara acha **um** tabuleiro na metade esquerda
(x 1273..1452, y 695..787) e, como o mundo é o espelho da metade, isso são as
duas pontes. O resultado é o mesmo para qualquer vão entre 100 e 200 px, então o
número não é ajuste fino. Ponte nova no mapa entra sozinha — inclusive nos
testes, que iteram sobre o que a máscara diz.

## Navegação dos bots (`NavGrid`)

Grid derivado da **mesma máscara de colisão**: célula de 32 px, 156 × 53 = 8268
células, montado uma vez na subida junto com os componentes conexos.

- **célula de 32 px** — a ponte tem ~96 px livres (3 células). Com 64 px ela
  sumiria do grid, e é justamente a travessia que o bot precisa achar;
- **raios da rainha** (a maior peça) — rota aprovada ali serve para qualquer rank.
  Usar o peão faria a rota passar por frestas onde a rainha empaca;
- **a água é rota, não barreira** — entra no grid com custo
  `1 / WATER_SPEED_FACTOR` (1,25) por passo, que é exatamente o tempo a mais que
  se leva ali. O A* prefere ponte e terra quando elas não são desvio grande, e
  manda nadar quando nadar é mais rápido;
- **a única regra de terreno é o parapeito** (`parapeito()`, espelho grosseiro de
  `canCross`), e ela vale nos **três** lugares que decidem caminho: a rotulagem
  dos componentes ("existe rota?"), a expansão do A* (inclusive as duas ortogonais
  de cada diagonal) e a **linha de visão** — sem esta última o bot enxergaria
  "reta livre" atravessando a lateral do tabuleiro e nem chegaria a pedir rota.

**O A* quase nunca roda.** `World.navigateAngle`, do mais barato ao mais caro:

1. **linha de visão livre** → vai direto e descarta a rota (caso comum);
2. **rota em andamento** → segue o waypoint;
3. **sem rota** → pede A*, respeitando `BOT_REPATH_MIN_MS` (700 ms por bot),
   `BOT_PATHS_PER_TICK` (2 na sala inteira) e a consulta O(1) de componentes
   (`canReach`), que descarta alvos inalcançáveis sem busca nenhuma.

Recálculo por **evento**: rota acabou, alvo andou mais que
`BOT_REPATH_TARGET_MOVE` (220 px), ou o bot travou.

**Bot travado:** a cada `BOT_STUCK_CHECK_MS` (600 ms) compara-se o quanto ele
andou; abaixo de `BOT_STUCK_MIN_PROGRESS` (24 px) a rota é descartada e o
recálculo liberado na hora. Só isso não resolve **quina** — o A* devolve
praticamente o mesmo caminho e ele reencalha. Por isso a travada também liga o
contorno (`BOT_UNSTICK_MS`, 500 ms), e a direção **é escolhida olhando o mapa**:
`escapeAngle` testa desvios crescentes (`BOT_UNSTICK_ANGLES`, 70° → 110° → 150°)
para os dois lados, começando pelo lado que ainda não foi tentado, e fica com o
primeiro que tem `BOT_UNSTICK_PROBE` (64 px) livres — medido com a MESMA linha de
visão e com o corpo do próprio bot, então um vão onde ele não cabe é recusado.
(`BOT_UNSTICK_ANGLE`, no singular, sobrou como fallback do caso "cercado por
todos os lados testados".)

A rota sai **suavizada**: pontos que dá para pular em linha reta são descartados,
senão o bot andaria em escadinha de 32 px. **Cuidado ao mexer em `suaviza()`** — a
primeira versão entrava em laço infinito quando nem o primeiro ponto tinha linha
de visão, e derrubava o processo com "invalid size error".

**Custo medido:** tick médio 0,10 ms com 10–20 bots e 0,21 ms com 40, dos 50 ms
de orçamento. Tráfego: ~1,5 KB/s por cliente. Nem CPU nem rede são gargalo.

## Colisão entre personagens (`CollisionResolver`)

Separação pelas **elipses**, não pelo retângulo do corpo. Como todas as elipses
têm a mesma proporção (`rx = ELLIPSE_RATIO * ry`, garantido por sprites
quadrados), o resolver multiplica Y por `ELLIPSE_RATIO`: no espaço resultante
toda elipse vira um círculo de raio `collisionRx` e a separação é um empurrão
radial exato. A correção é dividida pela massa (cada um absorve a fração da massa
**do outro**), com `SEPARATION_STRENGTH` suavizando e `OVERLAP_SLOP` (0,5 px)
evitando tremedeira.

Se um rank novo tiver sprite não-quadrado, a premissa `rx = 2 * ry` quebra e o
resolver perde a exatidão.

O resolver também grava `separationX/Y` — quanto empurrou cada ator no tick. É por
esse vetor que o `World` sabe que um **dash esbarrou em alguém** (empurrão contra
o sentido do dash, além de `DASH_STOP_PUSHBACK`).

## Combate, XP e o resto das regras

O detalhe de balanceamento — a escala de carga e seus expoentes, o empurrão, o
dash e a travessia do cavalo, a XP, a zona de cura, a água — está comentado
**no ponto onde acontece** em `constants.ts` e `World.ts`, e explicado por extenso
no `CLAUDE.md` do cliente. O que vale saber antes de mexer aqui:

- **ponto único de progressão:** `Actor.addExperience()`, chamado de um lugar só
  (`World.applyDamage`). A XP **nunca é gasta** ao subir de nível — o nível é
  `floor(xp / 100) + 1`, saturado em `MAX_LEVEL`. O nível **não é guardado nem
  trafega**: deriva do rank;
- **morrer não rebaixa a peça** (`resetProgressOnDeath`): o rank fica e a XP volta
  ao **piso do nível atual**. Zerar de verdade derrubaria o rank no primeiro
  `addExperience` seguinte; não mexer tornaria a morte grátis;
- **o botão DEBUG não afrouxa nada.** `World.debugCycleRank` cancela golpe e dash
  em curso (as duas máquinas guardam números derivados do rank) e **revalida a
  posição** — a rainha é maior que o peão, então um peão encaixado num vão viraria
  rainha dentro da parede; sem saída via `nearestFree`, a troca é recusada. A
  promoção em si passa pelo MESMO `applyLevel` da promoção por XP;
- **velocidade só sai de `movementFactor(attacking, charging, inWater)`.** Não
  existe nem pode existir um `speed *= 0.8` solto: foi assim que previsão e
  simulação ficaram idênticas;
- **bot não bate em alvo invulnerável** — só gastaria o cooldown. A cadência é uma
  **taxa por segundo** convertida com `1 - exp(-taxa * dt)`, não uma chance por
  tick, para desamarrar a agressividade de `TICK_MS`;
- **a esquiva do bot sorteia UMA vez por golpe**, com a chave `attackHitAt` do
  atacante guardada em `dodgeRolledFor`. Sorteando a cada tick, os ~200 ms de
  windup dariam ~4 chances e o bot esquivaria de tudo;
- **o bot mira como o jogador**: `World.aimAt` escreve no mesmo `aimDx`/`aimDy`
  do pacote de entrada, uma vez por golpe (e de novo antes de soltar a carga), e
  o ângulo sai da mesma `attackAimAngle`. Antes nenhum bot escrevia mira e todos
  batiam só a leste ou a oeste;
- **`botCanHit` mede o alcance na direção do golpe** (`ellipseRadiusAt`, não o
  raio em X) e não tem mais teste de faixa lateral — ver *Contratos com o
  cliente*.

## Testes

```bash
npm test   # 119 passando, 13 pendentes, ~13 s
```

- **`test/World.test.ts`** — a simulação, sem socket nenhum: combate, XP,
  colisão contra o cenário, travessia do rio e da ponte, navegação dos bots,
  cura na base, dash do cavalo, fim de partida, direção contínua do golpe e a
  regra "uma mira, um golpe" (jogador e bot). Roda em ~13 s porque decodifica a
  máscara de verdade;
- **`test/ArenaRoom.test.ts`** — a sala, com `@colyseus/testing`: slots, bots,
  `ack`, normalização de entrada, lobby, revanche, modos.

Três convenções dos testes, para não escrever teste intermitente:

1. **`itCarregado`** = `CHARGED_ATTACK_ENABLED ? it : it.skip`. Os 13 pendentes
   são estes. Teste novo que dependa de carga usa `itCarregado`, não `it`;
2. **`comSorteioCerto(fn)`** troca `Math.random` por `() => 0` — `stepBot` sorteia
   se ataca neste tick, e sem fixar isso os testes de decisão do bot oscilam;
3. **as posições são coordenadas reais do mapa.** `LIVRE_X/Y` (400, 800) é o pátio
   do castelo aliado; `FORA_X/Y` (1600, 840) é chão livre **fora** da `HEAL_ZONE`,
   para testes que medem dano com pausas longas não terem a base curando o alvo no
   meio. Uma coordenada qualquer pode cair em muralha e o `World` devolve o ator
   para `lastValid` no primeiro tick.

## Deploy

**Hoje o servidor está no Render**, não na Colyseus Cloud:
`SERVER_ENDPOINT = "wss://chess-armageddon-server.onrender.com"` no
`netconfig.js` do cliente, e é para lá que o `_smoke.mjs` conecta.
`ecosystem.config.cjs` (PM2, um processo por CPU) e o `index.ts` intocável
continuam prontos para a Colyseus Cloud — o README ainda descreve só esse
caminho.

O cliente é uma pasta estática (GitHub Pages, Netlify, Cloudflare Pages); o CORS
do matchmaking já vem liberado, então os dois podem ficar em domínios diferentes.

| Variável | Para quê |
| --- | --- |
| `NODE_ENV=production` | desliga o playground |
| `MONITOR_PASSWORD` | libera `/monitor`. **Sem ela a rota responde 404** |
| `MONITOR_USER` | opcional, padrão `admin` |
| `COLLISION_MASK_PATH` | sobrescreve o caminho da máscara |
| `PORT` | padrão 2567 |

`/monitor` expõe salas, sessionIds e estado do jogo. A rota **só existe** com
`MONITOR_PASSWORD`; a comparação é de tempo constante (`timingSafeEqual`).

### Erros que parecem CORS mas não são

Duas falhas diferentes produzem a **mesma** mensagem enganosa no navegador,
porque a página de erro da borda não traz `Access-Control-Allow-Origin`. O CORS
em si o Colyseus já resolve sozinho.

| Sintoma | Causa real |
| --- | --- |
| `/health` responde 200, `POST /matchmake/create/arena` devolve **523** | a máscara de colisão não carregou. Hoje isso derruba a subida com log claro — era assim antes de o load ir para o `app.config.ts` |
| `/health` 200, `joinOrCreate` funciona, só `joinById` devolve **522** | a sala da revanche já foi descartada. É o que `ROOM_JOIN_GRACE_SECONDS` resolve |

## Convenções

- **comentários, nomes internos e mensagens de commit em português**; commits
  seguem Conventional Commits (`feat:`, `fix:`, `feat(player):`). Nomes de campo
  do schema e do protocolo continuam em inglês — são contrato com o cliente;
- **`sim/` não importa Colyseus nem Phaser** (ver *Arquitetura*);
- **comentário explica o POR QUÊ, no ponto onde acontece.** O código deste
  repositório documenta as decisões e o que se mediu ("era 20/s, o que devolvia um
  peão em 5 s"; "medido: travadas caíram de 207 para 147"). Ao mexer numa
  constante ou numa regra, atualize o comentário junto — é ele que impede a
  decisão ser desfeita por acidente seis meses depois;
- **nada de número solto.** Constante nova vai para `constants.ts` e, se o cliente
  precisar dela, é espelhada em `Hierarchy.js`;
- **nada do cliente é confiável.** Toda entrada de fora passa por um `sanitize*`
  ou por um clamp, e a decisão fica no servidor.

## Pendências conhecidas

- **o `README.md` está desatualizado em quatro pontos**: diz que `npm start` é
  `tsx watch` (é `node build/index.js`), lista só `i`/`a`/`r` no protocolo, descreve
  a sala como "sempre 5 bots por time, entra e substitui bot" (hoje há lobby, com
  o número de bots escolhido na criação) e afirma que `autoDispose` está ligado
  (o `onCreate` o desliga por 90 s). Também descreve o deploy só para a Colyseus
  Cloud, quando o que está no ar é o Render;
- **o nome do arquivo da máscara difere entre os dois lados**
  (`arena_collision.png` no cliente, `collision.png` aqui), o que deixa o terceiro
  candidato de `CANDIDATOS` morto;
- **o cabeçalho de `paint-water.mjs` afirma que o script é idempotente.** Não é;
- `BOT_UNSTICK_ANGLE` (singular) só sobrevive como fallback de `escapeAngle`;
- **comentários citam um windup de "200 ms" que não existe mais.** Hoje ele
  escala com a carga (160..260 ms). Estão em `constants.ts:507` (que ainda cita
  uma constante extinta, `ATTACK_WINDUP_MS`), `constants.ts:585`, `constants.ts:591`
  e `World.ts:891`. O de `constants.ts:361` é proposital — contrasta com o valor
  antigo.
