round trip 25 ms, median of 3, budget 600/300 ms settled, 150 ms document server time

| viewer | page | pass | status | TTFB | settled | third-party images done | document round trips | /api fetches | document server-timing | last responses |
|---|---|---|---|---|---|---|---|---|---|---|
| anonymous | `/settingstest/demo` | cold | 200 | 38 | 151 | 124 | 2 | none | w-public-browse=33 w-total=33 | score@110+41 source-worker.js@129+-4 |
| anonymous | `/settingstest/demo` | warm | 200 | 16 | 145 | 94 | 1 | none | w-public-browse=3 w-total=3 | issues@93+52 score@93+41 |
| anonymous | `/settingstest/demo/issues` | cold | 200 | 41 | 178 | 152 | 1 | none | w-published-page=32 w-total=32 | demo@139+39 pulls@139+19 |
| anonymous | `/settingstest/demo/issues` | warm | 200 | 13 | 118 | 89 | 0 | none | w-published-page=2 w-total=2 | demo@67+51 pulls@67+49 |
| anonymous | `/settingstest/demo/issues/1` | cold | 200 | 11 | 66 | 136 | 0 | none | w-published-page=2 w-total=2 | 39t-uvu7e01b9.js@17+49 0-1g8ra2gdbjv.js@17+46 |
| anonymous | `/settingstest/demo/issues/1` | warm | 200 | 40 | 55 | 131 | 1 | none | w-published-page=32 w-total=32 | 39t-uvu7e01b9.js@45+10 1a1tgdqwgw0bx.js@45+10 |
| anonymous | `/settingstest/demo/pulls` | cold | 200 | 7 | 115 | 119 | 0 | none | w-published-page=3 w-total=3 | issues@100+14 actions@100+14 |
| anonymous | `/settingstest/demo/pulls` | warm | 200 | 42 | 137 | 116 | 1 | none | w-published-page=36 w-total=36 | issues@94+43 actions@94+37 |
| anonymous | `/settingstest/demo/actions` | cold | 200 | 38 | 168 | 156 | 1 | none | w-published-page=33 w-total=33 | pulls@121+47 agents@121+8 |
| anonymous | `/settingstest/demo/actions` | warm | 200 | 9 | 101 | 86 | 0 | none | w-published-page=3 w-total=3 | agents@62+40 pulls@62+12 |
| anonymous | `/settingstest/demo/agents` | cold | 200 | 38 | 144 | 138 | 1 | none | w-published-page=33 w-total=33 | score@110+34 actions@110+13 |
| anonymous | `/settingstest/demo/agents` | warm | 200 | 9 | 107 | 84 | 0 | none | w-published-page=3 w-total=3 | actions@61+46 score@61+41 |
| anonymous | `/settingstest` | cold | 200 | 8 | 65 | 157 | 0 | none | w-published-page=2 w-total=2 | 0-1g8ra2gdbjv.js@13+52 28ywx07sepmlm.js@13+51 |
| anonymous | `/settingstest` | warm | 200 | 40 | 56 | 131 | 1 | none | w-published-page=33 w-total=33 | 28ywx07sepmlm.js@46+10 0-1g8ra2gdbjv.js@46+10 |
| signed-in | `/settingstest/demo` | cold | 200 | 40 | 208 | 248 | 1 | none | w-privacy=30 w-app=5 w-total=35 | issues@123+85 source-worker.js@194+-3 |
| signed-in | `/settingstest/demo` | warm | 200 | 70 | 188 | 173 | 2 | none | w-privacy=28 w-app=37 w-total=65 | score@115+72 source-worker.js@180+-3 |
| signed-in | `/settingstest/demo/issues` | cold | 200 | 74 | 205 | 228 | 2 | none | w-privacy=28 w-app=41 w-total=69 | demo@133+73 pulls@133+57 |
| signed-in | `/settingstest/demo/issues` | warm | 200 | 58 | 180 | 160 | 1 | none | w-privacy=31 w-app=21 w-total=52 | pulls@119+60 demo@120+42 |
| signed-in | `/settingstest/demo/issues/1` | cold | 200 | 52 | 139 | 366 | 3 | none | w-privacy=27 w-app=20 w-total=47 | sami.png@98+41 39t-uvu7e01b9.js@98+40 |
| signed-in | `/settingstest/demo/issues/1` | warm | 200 | 56 | 115 | 175 | 3 | none | w-privacy=31 w-app=19 w-total=50 | sami.png@104+10 39t-uvu7e01b9.js@104+6 |
| signed-in | `/settingstest/demo/pulls` | cold | 200 | 52 | 235 | 180 | 1 | none | w-privacy=27 w-app=20 w-total=47 | actions@133+102 issues@133+59 |
| signed-in | `/settingstest/demo/pulls` | warm | 200 | 56 | 229 | 160 | 1 | none | w-static-route=1 w-privacy=29 w-app=21 w-total=51 | actions@118+111 issues@119+67 |
| signed-in | `/settingstest/demo/actions` | cold | 200 | 106 | 285 | 307 | 4 | none | w-privacy=31 w-app=68 w-total=99 | agents@184+101 pulls@184+61 |
| signed-in | `/settingstest/demo/actions` | warm | 200 | 106 | 251 | 212 | 4 | none | w-privacy=29 w-app=71 w-total=100 | agents@150+102 pulls@150+61 |
| signed-in | `/settingstest/demo/agents` | cold | 200 | 98 | 298 | 425 | 2 | none | w-privacy=28 w-app=66 w-total=94 | actions@193+106 score@192+42 |
| signed-in | `/settingstest/demo/agents` | warm | 200 | 105 | 260 | 210 | 2 | none | w-privacy=31 w-app=69 w-total=100 | actions@147+113 score@147+70 |
| signed-in | `/settingstest` | cold | 200 | 52 | 200 | 368 | 19 | none | w-privacy=28 w-app=18 w-total=46 | sami.png@156+45 3sjvpd7iy0uw-.js@155+43 |
| signed-in | `/settingstest` | warm | 200 | 52 | 172 | 271 | 19 | none | w-privacy=28 w-app=19 w-total=47 | sami.png@162+10 28ywx07sepmlm.js@162+6 |
