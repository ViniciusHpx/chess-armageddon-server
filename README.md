# chess-armageddon-server

Servidor **autoritativo** da arena multiplayer de [Chess Armageddon](../chess-armageddon).
Feito com [Colyseus](https://docs.colyseus.io/) 0.17 em TypeScript.

O cliente Phaser não simula nada no modo online: manda entrada e desenha o que
volta. Toda posição, dano, morte, promoção e aura nasce aqui.

## Rodar

```bash
npm install
npm start          # tsx watch, sobe em http://localhost:2567
```

Com o servidor de pé, sirva o cliente por HTTP a partir da raiz de
`../chess-armageddon` e abra no navegador:

```bash
cd ../chess-armageddon
npx http-server -p 8000 -c-1      # ou: python -m http.server 8000
```

| URL | O quê |
| --- | --- |
| `http://localhost:8000` | jogo online (padrão) |
| `http://localhost:8000/?offline=1` | jogo antigo, tudo no navegador |
| `http://localhost:8000/?name=Fulano` | escolhe o nome exibido |
| `http://localhost:8000/?server=wss://...` | aponta para outro servidor |
| `http://localhost:2567/health` | verificação de vida |
| `http://localhost:2567/` | playground do Colyseus (só fora de produção) |
| `http://localhost:2567/monitor` | painel — exige `MONITOR_PASSWORD` |

```bash
npm test           # 16 testes: simulação + sala
npm run typecheck  # tsc --noEmit
npm run build      # compila para build/
npm run loadtest   # clientes sintéticos (TUI interativa)
```

## Arquitetura

```
src/
  index.ts                    entrada (não editar: exigência da Colyseus Cloud)
  app.config.ts               rotas express, monitor protegido, playground
  rooms/
    ArenaRoom.ts              traduz mensagens <-> World e copia para o schema
    schema/ArenaState.ts      o que trafega na rede
  sim/                        SIMULAÇÃO — nada de Colyseus aqui dentro
    constants.ts              RANKS, mundo, combate  (FONTE DE VERDADE)
    Actor.ts                  personagem headless
    World.ts                  o tick: entrada -> IA -> física -> golpes
    CollisionResolver.ts      separação pelas elipses
    geometry.ts               testes forma-contra-elipse
    mathx.ts                  substitutos de Phaser.Math
```

`sim/` não importa nada de Colyseus nem de Phaser. Isso é o que deixa a
simulação testável em milissegundos (`test/World.test.ts` roda 10 cenários de
combate sem abrir socket nenhum) e o que permitiria rodá-la em outro transporte.

### O tick

20 ticks por segundo (`TICK_MS`), na ordem do `update` + `postupdate` da cena
original:

1. entrada dos jogadores / IA dos bots → define velocidade
2. integra a velocidade
3. `resolveCollisions` separa quem se sobrepõe
4. `clampToWorld` prende ao mapa (última palavra sobre a posição)
5. aplica os golpes cujo windup de 200 ms venceu
6. renasce os bots

O patch de estado sai na mesma cadência (`setPatchRate(TICK_MS)`).

### Protocolo

Cliente → servidor (nomes curtos: vão a 20 Hz):

| Tipo | Carga | O quê |
| --- | --- | --- |
| `i` | `{dx, dy}` | vetor de movimento; o servidor normaliza |
| `a` | `1` \| `0` | apertou / soltou o botão de ataque |
| `r` | — | pedido de renascer |

Servidor → cliente: o `state` (schema) e a mensagem `kill` `{killer, victim}`.

### O que o servidor não aceita do cliente

- **Módulo do vetor de movimento** — `setInput` normaliza; mandar `dx: 999` anda
  igual a `dx: 1` (`test/ArenaRoom.test.ts`).
- **"Meu golpe foi carregado"** — o cliente só diz *apertei* e *soltei*; quem
  cronometra é o servidor, com o próprio relógio.
- **Posição** — nunca trafega do cliente para o servidor.
- **Dano** — a geometria do golpe é avaliada aqui.

### Times e bots

A sala nasce com `TEAM_SIZE` (5) personagens de cada lado, todos bots. Quem
entra é posto no time com menos humanos e **substitui um bot**, então o total
fica sempre em 10. Ao sair, o bot volta. Ninguém entra numa arena vazia.

`autoDispose` está ligado: sem jogadores a sala morre, para não queimar CPU
simulando bots para plateia nenhuma.

### Reconexão

Queda de rede congela o personagem por `RECONNECTION_SECONDS` (20 s) em vez de
removê-lo. Saída consentida (`leave()`) remove na hora.

### Entrada expirada

O servidor guarda o último vetor recebido. Se o cliente parar de falar — aba em
segundo plano faz o Phaser pausar o loop — o boneco andaria sozinho até a
parede. Duas travas:

- o cliente reenvia a entrada a cada 500 ms e manda `{0,0}` ao perder o foco;
- o servidor zera o movimento após `INPUT_TIMEOUT_MS` (2 s) sem pacote.

## Diferenças em relação ao jogo offline

O modo offline (`?offline=1`) continua existindo e não foi tocado. A simulação
do servidor é um porte fiel dele, com quatro mudanças deliberadas — todas
comentadas no código, no ponto onde acontecem:

| Offline | Servidor | Por quê |
| --- | --- | --- |
| a velocidade persistia durante o golpe (o boneco deslizava 200 ms) | fica parado | o deslize era efeito colateral do Arcade, não decisão de jogo |
| o lado do L do cavalo era recalculado no impacto | congelado no início do golpe | o cliente desenha durante todo o golpe; recalcular fazia o dano sair de onde não apareceu |
| todos nasciam em qualquer ponto do mapa | cada um nasce no lado do próprio time | com times de verdade, dava para renascer dentro do inimigo |
| `HumanPlayer` batia em `scene.enemyPlayers` mesmo tendo `team = 'human'` | alvo sai do time real | a inconsistência está anotada no `CLAUDE.md` do cliente |

## Sincronia com o cliente

Duas coisas **têm** de bater exatamente entre os dois lados, senão o golpe
acerta fora do que aparece na tela:

1. **`RANKS`** — `src/sim/constants.ts` é a fonte de verdade;
   `chess-armageddon/src/constants/Hierarchy.js` é a cópia de desenho.
   `RANK_ORDER` define o `uint8` que trafega: a ordem não pode mudar de um lado só.
2. **A fórmula do centro da elipse** — `Actor.ellipseCenter()` aqui e
   `ArenaActor.getEllipseCenter()` lá. Ela reproduz o `body.center` do Arcade:
   `centerY = y + altura/2 - collisionRx + collisionRy * 4/3`.

## Deploy na Colyseus Cloud

`ecosystem.config.cjs` já está configurado (PM2, um processo por CPU) e
`npm run build` gera `build/`. O deploy em si é feito pelo painel da Colyseus
Cloud, ligando o repositório Git — veja
[docs.colyseus.io/deployment/cloud](https://docs.colyseus.io/deployment/cloud).

No painel, defina as variáveis:

| Variável | Para quê |
| --- | --- |
| `NODE_ENV=production` | desliga o playground |
| `MONITOR_PASSWORD` | libera `/monitor`. **Sem ela a rota responde 404** |
| `MONITOR_USER` | opcional, padrão `admin` |

Depois, no cliente, ponha o endpoint `wss://` em
`chess-armageddon/src/net/netconfig.js` (`SERVER_ENDPOINT`) e publique a pasta
`chess-armageddon` em qualquer host estático (GitHub Pages, Netlify, Cloudflare
Pages). O CORS do matchmaking já vem liberado, então cliente e servidor podem
ficar em domínios diferentes.

## Segurança

`/monitor` expõe salas, sessionIds e estado do jogo. A rota **só existe** se
`MONITOR_PASSWORD` estiver definida; sem ela devolve 404. A comparação da senha
é de tempo constante (`timingSafeEqual`).
