/* ============================= SERVICE WORKER DO SISTEMA RH =============================
   Faz o sistema ABRIR sem internet. Criado em 12/09/2026, junto com o modo offline: o modo
   offline só servia para quem já estava com a página aberta — recarregar ou abrir o
   sistema com a internet fora dava a tela de "sem conexão" do navegador, porque a página
   mora no GitHub Pages.

   Precisa ficar na MESMA pasta do index.html no repositório (RH-SISTEMA). O alcance dele é
   só /RH-SISTEMA/ — o Sistema de Estoque, no mesmo domínio, não é tocado.

   Três regras, uma para cada tipo de arquivo:

   1. A PÁGINA (index.html) vem da REDE PRIMEIRO, sem cache HTTP (`no-cache`), e a cópia
      guardada só é usada se a rede falhar ou demorar mais que ESPERA_REDE. Assim a versão
      publicada chega na hora em todos os computadores — o service worker não pode virar
      mais um cache que engana (ver o Ctrl+F5 da VERSAO_SISTEMA). Toda resposta boa da
      rede atualiza a cópia.
   2. As BIBLIOTECAS do CDN (xlsx, jspdf, supabase-js) têm a versão no endereço e nunca
      mudam: vêm do cache primeiro. Trocar a versão no index.html troca o endereço, e o
      endereço novo é buscado na rede.
   3. As IMAGENS da pasta assets/ vêm do cache e se atualizam por trás. A FONTE (Google
      Fonts) também: a folha se renova por trás, os arquivos .woff2 vêm do cache.

   Nada mais é interceptado: o banco (Supabase), o login e o realtime passam direto — dado
   do banco nunca sai de cache daqui. Dado offline é assunto da fila do caixa, no index.

   Para DESLIGAR tudo um dia: publicar este arquivo só com
     self.addEventListener('install', ()=> self.skipWaiting());
     self.addEventListener('activate', e=> e.waitUntil(self.registration.unregister()));
   e tirar o registro do index.html. */

const CACHE = 'rh-sistema-v1';
const ESPERA_REDE = 5000;   /* internet oscilando: passado isso, abre a cópia guardada */

const ESCOPO = self.registration.scope;
const PAGINA = new URL('index.html', ESCOPO).href;
const LIBS = [
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js'
];
const IMAGENS = [new URL('assets/logo.jpg', ESCOPO).href];

self.addEventListener('install', (e)=>{
  e.waitUntil((async ()=>{
    const c = await caches.open(CACHE);
    /* Cada item por conta própria: um que falhe não impede os outros de ficarem guardados. */
    await Promise.all([
      fetch(PAGINA, {cache: 'no-cache'})
        .then(r=> r.ok ? Promise.resolve(semRedirecionamento(r)).then(limpa=> c.put(PAGINA, limpa)) : null)
        .catch(()=>{}),
      ...IMAGENS.map(u=> fetch(u).then(r=> r.ok ? c.put(u, r) : null).catch(()=>{})),
      /* A página carrega essas bibliotecas por <script> comum, sem CORS: a resposta é
         "opaca" e é assim mesmo que ela precisa ser guardada para servir de volta. */
      ...LIBS.map(u=> fetch(u, {mode: 'no-cors'}).then(r=> c.put(u, r)).catch(()=>{}))
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e)=>{
  e.waitUntil((async ()=>{
    const nomes = await caches.keys();
    await Promise.all(nomes.filter(n=> n.startsWith('rh-sistema-') && n !== CACHE).map(n=> caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e)=>{
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = req.url.split('#')[0];
  if(req.mode === 'navigate' && url.startsWith(ESCOPO)){
    e.respondWith(paginaRedePrimeiro(req));
  }else if(LIBS.indexOf(url) >= 0){
    e.respondWith(cachePrimeiro(req, url));
  }else if(url.startsWith(new URL('assets/', ESCOPO).href)){
    e.respondWith(cacheAtualizandoPorTras(req, url));
  }else if(url.startsWith('https://fonts.googleapis.com/')){
    /* A folha da fonte (Google Sans Flex, redesenho de 12/09/2026): guardada e renovada
       por trás, para abrir sem internet já com a tipografia do sistema. */
    e.respondWith(cacheAtualizandoPorTras(req, url));
  }else if(url.startsWith('https://fonts.gstatic.com/')){
    /* Os arquivos da fonte têm a versão no endereço e nunca mudam. */
    e.respondWith(cachePrimeiro(req, url));
  }
  /* o resto (Supabase, etc.) segue direto para a rede */
});

/* Navegação não aceita resposta que veio de um redirecionamento: o Chrome recusa e mostra
   erro. Refazer a resposta sem a marca resolve. */
function semRedirecionamento(r){
  if(!r.redirected) return r;
  return r.blob().then(corpo=> new Response(corpo, {status: r.status, statusText: r.statusText, headers: r.headers}));
}

async function paginaRedePrimeiro(req){
  const c = await caches.open(CACHE);
  const daRede = fetch(req.url, {cache: 'no-cache', credentials: 'same-origin'}).then(async r=>{
    const limpa = await semRedirecionamento(r);
    if(limpa.ok) await c.put(PAGINA, limpa.clone());
    return limpa;
  });
  try{
    return await Promise.race([
      daRede,
      new Promise((_, rej)=> setTimeout(()=> rej(new Error('rede lenta')), ESPERA_REDE))
    ]);
  }catch(err){
    const guardada = await c.match(PAGINA);
    if(guardada){
      daRede.catch(()=>{});   /* se a rede ainda responder, a cópia se atualiza para a próxima */
      return guardada;
    }
    return daRede;            /* nunca guardou nada: só resta esperar a rede */
  }
}

async function cachePrimeiro(req, url){
  const c = await caches.open(CACHE);
  const guardada = await c.match(url);
  if(guardada) return guardada;
  const r = await fetch(req);
  if(r.ok || r.type === 'opaque') c.put(url, r.clone()).catch(()=>{});
  return r;
}

async function cacheAtualizandoPorTras(req, url){
  const c = await caches.open(CACHE);
  const guardada = await c.match(url);
  const daRede = fetch(req).then(r=>{
    if(r.ok || r.type === 'opaque') c.put(url, r.clone()).catch(()=>{});
    return r;
  });
  if(guardada){ daRede.catch(()=>{}); return guardada; }
  return daRede;
}
