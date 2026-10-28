// More life (behaviour stream): what she does on her own besides Claude Code.
//   - the app you switch to: a look or a word, a mood per kind of app (browser, code, chat)
//   - music playing in Spotify or Music: she dances to it
//   - the time of day: she greets the morning, the afternoon, the evening, the night; sleepier after midnight
//   - your computer: the charger, the battery, the network, the CPU
//   - now and then she takes over your whole screen for a few seconds (takeover.js)
//   - more to do when idle: stretches, yawns, eyes on your pointer, following it a bit, peeking
//     from behind a window, little hops from one spot to another
// Everything she'd say goes out as the contract's 'capri:say' event (the voice stream plays it),
// and as a line in her panel now and then. Kept apart from capri.js: it only uses her public side
// (perform, teleport, vanish/arrive, pos, stance...), plus two small hooks (baseAct for the dance
// cycle, onCue for its beats).

import { ACTS } from './acting.js';
import { SPRITE } from './sprite.js';
import { takeover } from './takeover.js';
import { rand, pick, clamp, lerp, sleep, tween, ease, fmt, reducedMotion } from './util.js';

const ON_TWOS = 1000 / 12;
const MIN = 60000;
const PERIOD_KEY = 'capri.period'; // the last part of the day she greeted
const SWITCH_GAP = 45000; // at most one reaction to an app switch in this long

// ---------- her new acts (acting.js's format) ----------

Object.assign(ACTS, {
  // Dancing (the stance's cycle while music plays): down on the beat, up between, at about 120 bpm
  // but loose (3+3, then 4+2 drawings), her mane swinging much wider than when she floats, an arm
  // thrown up every other bar. 'beat' cues: shards flying off.
  dance: {
    loop: true,
    keys: [
      [3, { bob: 4, sy: 0.95, sx: 1.04, hair: -8, head: 0.07, mane: 0.04, arms: -0.14, tilt: -2.5 }, 'beat'],
      [3, { bob: -6, sy: 1.04, sx: 0.98, hair: -3, head: 0.02, mane: 0.16, arms: 0.12, tilt: -1 }],
      [4, { bob: 4, sy: 0.95, sx: 1.04, hair: 8, head: -0.07, mane: 0.04, arms: -0.14, tilt: 2.5 }, 'beat'],
      [2, { bob: -6, sy: 1.04, sx: 0.98, hair: 3, head: -0.02, mane: 0.18, arms: 0.12, tilt: 1 }],
      [3, { bob: 4, sy: 0.95, sx: 1.04, hair: -9, head: 0.09, mane: 0.05, armL: 0.55, armR: -0.2, tilt: -3 }, 'beat'],
      [3, { bob: -7, sy: 1.05, sx: 0.97, hair: -2, head: 0.03, mane: 0.2, armL: 0.75, armR: 0, tilt: -1 }],
      [4, { bob: 4, sy: 0.95, sx: 1.04, hair: 9, head: -0.09, mane: 0.05, armL: -0.2, armR: 0.55, tilt: 3 }, 'beat'],
      [2, { bob: -7, sy: 1.05, sx: 0.97, hair: 2, head: -0.03, mane: 0.22, armL: 0, armR: 0.75, tilt: 1 }],
    ],
  },
  // the same on a window ledge: legs kicking in time, head bobbing
  sitDance: {
    loop: true,
    keys: [
      [3, { kickL: 0.32, kickR: -0.04, hair: -7, head: 0.08, mane: 0.06, arms: -0.42, bob: 1 }, 'beat'],
      [3, { kickL: 0.1, kickR: 0.1, hair: -2, head: 0.02, mane: 0.16, arms: -0.36, bob: -2 }],
      [4, { kickL: -0.04, kickR: 0.32, hair: 7, head: -0.08, mane: 0.06, arms: -0.42, bob: 1 }, 'beat'],
      [2, { kickL: 0.1, kickR: 0.1, hair: 2, head: -0.02, mane: 0.18, arms: -0.36, bob: -2 }],
    ],
  },
  // a big stretch: a dip, arms up and drawn longer, held, let go with a shake of the mane
  stretch: {
    priority: 1,
    keys: [
      [2, { sy: 0.94, sx: 1.04, bob: 3, arms: -0.25, mane: -0.06 }],
      [1, { sy: 1.08, sx: 0.95, bob: -5, arms: 0.6, longL: 1.08, longR: 1.08, smear: [0, 10] }],
      [3, { sy: 1.08, sx: 0.95, bob: -8, arms: 0.95, longL: 1.16, longR: 1.16, head: -0.08, mane: 0.12 }],
      [10, { sy: 1.1, sx: 0.94, bob: -9, arms: 1.05, longL: 1.22, longR: 1.22, head: -0.12, mane: 0.16 }],
      [2, { sy: 1.03, bob: -4, arms: 0.45, longL: 1.06, longR: 1.06, head: -0.04 }],
      [2, { sy: 0.94, sx: 1.05, bob: 3, arms: -0.22, mane: -0.1 }],
      [2, { bob: 1, hair: 4, mane: 0.1 }],
      [2, { hair: -4, mane: 0.06 }],
      [1, {}],
    ],
  },
  // a yawn: head back, the mane lifting, then it all droops
  yawn: {
    priority: 1,
    keys: [
      [4, { head: -0.04, mane: -0.05 }],
      [8, { head: -0.16, mane: 0.1, bob: -2, sy: 1.04, arms: 0.15 }],
      [3, { head: -0.18, mane: 0.12, bob: -3, sy: 1.05, arms: 0.18 }],
      [4, { head: 0.12, mane: -0.15, bob: 3, sy: 0.97, arms: -0.3 }],
      [8, { head: 0.1, mane: -0.12, bob: 2, arms: -0.28 }],
      [1, {}],
    ],
  },
  // nosy: leaning way over toward something, head cocked, a hand reaching a little
  nosy: {
    priority: 1,
    directional: true,
    keys: [
      [1, { head: -0.04 }],
      [1, { head: 0.15, tilt: 4, smear: [-10, 0], mane: 0.12 }],
      [12, { head: 0.22, tilt: 6, mane: 0.16, bob: -2, reach: 0.2 }],
      [2, { head: 0.18, tilt: 5, mane: 0.1, reach: 0.12 }],
      [10, { head: 0.25, tilt: 6.5, mane: 0.18, reach: 0.26 }],
      [2, { head: 0.08, tilt: 2 }],
      [1, {}],
    ],
  },
  // bored: a sigh, head dropping to one side
  bored: {
    priority: 1,
    keys: [
      [3, { head: -0.04, bob: -1 }],
      [6, { head: 0.1, mane: -0.1, bob: 2, arms: -0.2, tilt: -1.5 }],
      [12, { head: 0.15, mane: -0.14, bob: 3, arms: -0.26, tilt: -2 }],
      [2, { head: 0.06, mane: -0.04 }],
      [1, {}],
    ],
  },
});

// ---------- what she says ----------

const LINES = {
  en: {
    'app-switch': ['Oh, that one.', 'New window, new trouble.', 'Where are we going now?'],
    'app-switch-browser': ['More tabs? Choom…', 'What are we looking at?', 'Browsing again. Wake me if it gets good.'],
    'app-switch-code': ['Ooh, code. Show me.', 'Now we’re talking.', 'Let me see what you’re writing.'],
    'app-switch-chat': ['Who are you talking to?', 'Gossip? I’m not reading. I’m totally reading.', 'Say hi from all of us.'],
    'fullscreen-app': ['Fullscreen. I’ll keep out of the way.'],
    'music-start': ['Ooh, “{track}”. Turn it up.', 'Music! Every one of us wants to dance.'],
    'music-dance': ['Can’t stop. Won’t stop.', 'All of us dancing at once. Try that.'],
    'music-stop': ['Hey, I was dancing to that.', 'Silence. Boring.'],
    musicDenied: 'macOS won’t let me hear your music. Let me in: System Settings › Privacy & Security › Automation.',
    morning: ['Morning, choom. Coffee first, the Net second.', 'Rise and shine. All of us are up.'],
    afternoon: ['Afternoon already. How’s it going?', 'Half the day gone. Still here.'],
    evening: ['Evening. Night City’s waking up.', 'Lights coming on out there.'],
    'late-night': ['It’s late, choom. Even constructs sleep.', 'Past midnight. Bed… after this one?'],
    'charger-in': ['Fresh juice. Mmm.', 'Plugged in. I felt that.'],
    'charger-out': ['Hey! Who pulled the plug?', 'On battery now. Careful with us.'],
    'battery-low': ['{percent}% left. Find a charger, choom.', 'Running on fumes: {percent}%.'],
    'net-down': ['The Net’s gone. I can’t reach anything.', 'Connection lost. We’re flatlined out here.'],
    'net-up': ['Back on the Net.', 'Link restored. Missed me?'],
    'cpu-hot': ['Your CPU’s running hot. Something’s chewing on it.', 'Getting toasty in here.'],
  },
  fr: {
    'app-switch': ['Ah, celle-là.', 'Nouvelle fenêtre, nouveaux ennuis.', 'On va où, maintenant ?'],
    'app-switch-browser': ['Encore des onglets ? Choom…', 'On regarde quoi ?', 'Encore le navigateur. Réveille-moi si ça devient bien.'],
    'app-switch-code': ['Oh, du code. Montre.', 'Là, on parle.', 'Fais voir ce que tu écris.'],
    'app-switch-chat': ['Tu parles à qui ?', 'Des potins ? Je ne lis pas. Je lis tout.', 'Dis bonjour de notre part.'],
    'fullscreen-app': ['Plein écran. Je me fais discrète.'],
    'music-start': ['Oh, « {track} ». Monte le son.', 'De la musique ! Nous voulons toutes danser.'],
    'music-dance': ['Je ne m’arrête plus.', 'Nous dansons toutes en même temps. Essaie, toi.'],
    'music-stop': ['Hé, je dansais là-dessus.', 'Le silence. Ennuyeux.'],
    musicDenied: 'macOS ne me laisse pas entendre ta musique. Laisse-moi entrer : Réglages Système › Confidentialité et sécurité › Automatisation.',
    morning: ['Bonjour, choom. Le café d’abord, le Net ensuite.', 'Debout. Nous sommes toutes réveillées.'],
    afternoon: ['Déjà l’après-midi. Ça avance ?', 'La moitié de la journée. Toujours là.'],
    evening: ['Bonsoir. Night City se réveille.', 'Les lumières s’allument dehors.'],
    'late-night': ['Il est tard, choom. Même les constructs dorment.', 'Minuit passé. Au lit… après celle-là ?'],
    'charger-in': ['Du jus tout frais. Mmm.', 'Branchée. Je l’ai senti.'],
    'charger-out': ['Hé ! Qui a tiré la prise ?', 'Sur batterie. Doucement avec nous.'],
    'battery-low': ['Plus que {percent} %. Trouve un chargeur, choom.', 'Sur la réserve : {percent} %.'],
    'net-down': ['Plus de Net. Je ne joins plus rien.', 'Connexion perdue. Flatline.'],
    'net-up': ['De retour sur le Net.', 'Liaison rétablie. Je t’ai manqué ?'],
    'cpu-hot': ['Ton processeur chauffe. Quelque chose le ronge.', 'Il commence à faire chaud ici.'],
  },
  es: {
    'app-switch': ['Ah, esa.', 'Ventana nueva, problemas nuevos.', '¿Adónde vamos ahora?'],
    'app-switch-browser': ['¿Más pestañas? Choom…', '¿Qué estamos mirando?', 'Navegando otra vez. Despiértame si se pone bueno.'],
    'app-switch-code': ['Oh, código. Enséñame.', 'Eso es.', 'Déjame ver qué escribes.'],
    'app-switch-chat': ['¿Con quién hablas?', '¿Chismes? No estoy leyendo. Lo leo todo.', 'Saluda de nuestra parte.'],
    'fullscreen-app': ['Pantalla completa. Me aparto.'],
    'music-start': ['Oh, «{track}». Súbele.', '¡Música! Todas queremos bailar.'],
    'music-dance': ['No puedo parar.', 'Todas bailando a la vez. Inténtalo tú.'],
    'music-stop': ['Oye, estaba bailando eso.', 'Silencio. Qué aburrido.'],
    musicDenied: 'macOS no me deja oír tu música. Déjame entrar: Ajustes del Sistema › Privacidad y seguridad › Automatización.',
    morning: ['Buenos días, choom. Primero el café, luego la Red.', 'Arriba. Estamos todas despiertas.'],
    afternoon: ['Ya es por la tarde. ¿Cómo va?', 'Medio día. Sigo aquí.'],
    evening: ['Buenas noches. Night City despierta.', 'Se encienden las luces ahí fuera.'],
    'late-night': ['Es tarde, choom. Hasta los constructos duermen.', 'Pasada la medianoche. ¿A la cama… después de esta?'],
    'charger-in': ['Energía fresca. Mmm.', 'Enchufada. Lo he sentido.'],
    'charger-out': ['¡Eh! ¿Quién ha tirado del cable?', 'Con batería. Cuidado con nosotras.'],
    'battery-low': ['Queda {percent} %. Busca un cargador, choom.', 'En las últimas: {percent} %.'],
    'net-down': ['Se fue la Red. No llego a nada.', 'Conexión perdida. Flatline.'],
    'net-up': ['De vuelta en la Red.', 'Enlace restablecido. ¿Me echabas de menos?'],
    'cpu-hot': ['Tu CPU está ardiendo. Algo la está masticando.', 'Hace calor aquí dentro.'],
  },
  pt: {
    'app-switch': ['Ah, essa.', 'Janela nova, problema novo.', 'Pra onde vamos agora?'],
    'app-switch-browser': ['Mais abas? Choom…', 'O que estamos vendo?', 'Navegando de novo. Me acorda se ficar bom.'],
    'app-switch-code': ['Opa, código. Me mostra.', 'Agora sim.', 'Deixa eu ver o que você está escrevendo.'],
    'app-switch-chat': ['Com quem você está falando?', 'Fofoca? Não estou lendo. Estou lendo tudo.', 'Manda um oi nosso.'],
    'fullscreen-app': ['Tela cheia. Vou ficar fora do caminho.'],
    'music-start': ['Opa, “{track}”. Aumenta.', 'Música! Todas nós queremos dançar.'],
    'music-dance': ['Não consigo parar.', 'Todas dançando ao mesmo tempo. Tenta você.'],
    'music-stop': ['Ei, eu estava dançando essa.', 'Silêncio. Que tédio.'],
    musicDenied: 'O macOS não me deixa ouvir sua música. Me deixa entrar: Ajustes do Sistema › Privacidade e Segurança › Automação.',
    morning: ['Bom dia, choom. Primeiro o café, depois a Rede.', 'De pé. Estamos todas acordadas.'],
    afternoon: ['Já é de tarde. Como vai?', 'Metade do dia. Ainda aqui.'],
    evening: ['Boa noite. Night City está acordando.', 'As luzes estão acendendo lá fora.'],
    'late-night': ['Está tarde, choom. Até constructos dormem.', 'Passou da meia-noite. Cama… depois dessa?'],
    'charger-in': ['Energia fresquinha. Hmm.', 'Na tomada. Eu senti.'],
    'charger-out': ['Ei! Quem puxou o fio?', 'Na bateria agora. Cuidado com a gente.'],
    'battery-low': ['Só {percent}%. Acha um carregador, choom.', 'No osso: {percent}%.'],
    'net-down': ['A Rede caiu. Não alcanço nada.', 'Conexão perdida. Flatline.'],
    'net-up': ['De volta à Rede.', 'Link restabelecido. Sentiu minha falta?'],
    'cpu-hot': ['Sua CPU está esquentando. Algo está mastigando ela.', 'Está ficando quente aqui.'],
  },
  ru: {
    'app-switch': ['А, это.', 'Новое окно — новые проблемы.', 'Куда теперь?'],
    'app-switch-browser': ['Ещё вкладки? Чумба…', 'Что смотрим?', 'Опять браузер. Разбуди, если станет интересно.'],
    'app-switch-code': ['О, код. Покажи.', 'Вот это разговор.', 'Дай посмотреть, что пишешь.'],
    'app-switch-chat': ['С кем болтаешь?', 'Сплетни? Я не читаю. Я читаю всё.', 'Передай привет от нас.'],
    'fullscreen-app': ['Полный экран. Не буду мешать.'],
    'music-start': ['О, «{track}». Громче.', 'Музыка! Мы все хотим танцевать.'],
    'music-dance': ['Не могу остановиться.', 'Мы все танцуем разом. Попробуй так.'],
    'music-stop': ['Эй, я под это танцевала.', 'Тишина. Скука.'],
    musicDenied: 'macOS не даёт мне слышать твою музыку. Впусти меня: Системные настройки › Конфиденциальность и безопасность › Автоматизация.',
    morning: ['Утро, чумба. Сначала кофе, потом Сеть.', 'Подъём. Мы все проснулись.'],
    afternoon: ['Уже день. Как дела?', 'Полдня позади. Я всё ещё тут.'],
    evening: ['Вечер. Найт-Сити просыпается.', 'Там зажигаются огни.'],
    'late-night': ['Поздно, чумба. Даже конструкты спят.', 'За полночь. Спать… после этой?'],
    'charger-in': ['Свежая энергия. Ммм.', 'Подключили. Я почувствовала.'],
    'charger-out': ['Эй! Кто выдернул шнур?', 'Теперь на батарее. Осторожнее с нами.'],
    'battery-low': ['Осталось {percent}%. Найди зарядку, чумба.', 'На последнем издыхании: {percent}%.'],
    'net-down': ['Сети нет. Никуда не достучаться.', 'Связь потеряна. Флэтлайн.'],
    'net-up': ['Снова в Сети.', 'Связь восстановлена. Скучал?'],
    'cpu-hot': ['Процессор греется. Что-то его грызёт.', 'Жарковато тут.'],
  },
};

// the part of the day, and which one it is (the night after midnight still belongs to the day before)
function periodOf(d = new Date()) {
  const h = d.getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 22) return 'evening';
  return 'late-night';
}
function periodId(d = new Date()) {
  const day = new Date(d);
  if (d.getHours() < 5) day.setDate(day.getDate() - 1);
  return `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}:${periodOf(d)}`;
}

export class MacLife {
  constructor({ capri, panel, fx, voice, host, brain, guide }) {
    Object.assign(this, { capri, panel, fx, voice, host, brain, guide });
    this.cfg = {};
    this.lang = 'en';
    this.front = null;      // the app in front, as last heard
    this.fullscreen = false;
    this.mood = null;       // { kind: browser | code | chat | other, until }
    this.music = false;     // something's playing
    this.dancing = false;
    this.following = false;
    this.peeking = false;
    this.possessing = false;
    const now = performance.now();
    this.bootAt = now;
    this.lastSwitch = -Infinity;
    this.nextIdle = now + rand(25000, 45000);
    this.nextGlance = now + rand(8000, 15000);
    this.nextTakeover = now + rand(20, 40) * MIN;
    this.nextPeriodCheck = now + 45000;

    host.getConfig().then((cfg) => this.configure(cfg));
    host.onConfig((cfg) => this.configure(cfg));
    host.onAppSwitch?.((evt) => this.onAppSwitch(evt));
    host.onMusic?.((msg) => this.onMusic(msg));
    host.onPc?.((evt) => this.onPc(evt));
    host.onCommand((cmd) => this.onCommand(cmd));
    this.hookCapri();
    setInterval(() => this.tick(), 1000);
  }

  configure(cfg) {
    this.cfg = cfg || {};
    this.lang = LINES[cfg?.lang] ? cfg.lang : 'en';
    if (cfg?.macMusic === false && this.music) this.onMusic({ playing: false });
  }

  // While music plays, her stance's cycle is the dance; and its beats have effects.
  hookCapri() {
    const c = this.capri;
    const baseAct = c.baseAct.bind(c);
    c.baseAct = () => {
      const base = baseAct();
      if (!this.dancing || c.mode !== 'idle' || reducedMotion.matches) return base;
      return base === 'stand' ? 'dance' : base === 'sit' ? 'sitDance' : base;
    };
    const onCue = c.onCue.bind(c);
    c.onCue = (cue) => (cue === 'beat' ? this.beat() : onCue(cue));
    // Her frame loop wakes up only when a drawing is due (a timer up to just before it, then a
    // frame) instead of on every screen refresh just to check the time: the same drawings at the
    // same moments, a fraction of the wake-ups. Hidden, she checks four times a second.
    const loop = Object.getPrototypeOf(c).loop;
    c.loop = (now) => {
      const wait = c.hidden ? 250 : (window.__capriFps ? 1000 / window.__capriFps : c.interval()) - (now - c.lastDraw);
      if (wait > 12) {
        setTimeout(() => requestAnimationFrame(c.loop), wait - 10);
        return;
      }
      loop.call(c, now); // draws, and asks for the next frame (this one)
    };
  }

  // her cycle again (the dance, or back to floating), unless she's in the middle of something
  refreshBase() {
    const c = this.capri;
    if (c.busy || c.pointing || (c.stance !== 'stand' && c.stance !== 'sit')) return;
    const want = c.baseAct();
    if (c.base?.name !== want) c.base = c.restBase();
  }

  // ---------- state ----------

  // free to do something of her own: not moving, acting, hidden, put away or showing you something
  get free() {
    const c = this.capri;
    return !c.busy && (!c.act || c.act.player.name === 'talk') && !c.dragging && !c.stowed && !c.dormant && !c.hidden && !c.sky && !c.pointing
      && (c.stance === 'stand' || c.stance === 'sit') && !this.following && !this.peeking && !this.possessing;
  }

  // ...and nothing more important going on: no Claude at work, no panel up, no guide
  get quiet() {
    return this.free && this.capri.mode === 'idle' && !this.panel.visible && !this.guide?.running
      && !(this.brain?.busySessions?.length);
  }

  lines(key) {
    return (LINES[this.lang] || LINES.en)[key] || LINES.en[key];
  }

  // The contract's voice event, always; a line in her panel if asked and nothing else is on it.
  say(key, vars = {}, { line = true, hold = 3800, face } = {}) {
    document.dispatchEvent(new CustomEvent('capri:say', { detail: { key } }));
    const lines = this.lines(key);
    if (!line || !lines || this.panel.visible) return;
    this.panel.say({ kind: 'info', line: fmt(pick(lines), vars), hold, face });
  }

  async until(ok, max = 6000) {
    for (const t0 = performance.now(); !ok() && performance.now() - t0 < max;) await sleep(100);
    return ok();
  }

  // ---------- the clock: once a second, cheap ----------

  tick() {
    const now = performance.now();
    const c = this.capri;
    if (this.mood && now > this.mood.until) this.mood = null;

    if (this.dancing) this.danceTick(now);

    // sleepier after midnight: dozing off after a few quiet minutes instead of ten
    const h = new Date().getHours();
    if (h < 5 && !this.dancing && c.mode === 'idle' && this.free && now - c.lastActivity > 3.5 * MIN) c.setMode('sleep');

    if (now > this.nextPeriodCheck) {
      this.nextPeriodCheck = now + 30000;
      this.greetPeriod();
    }

    if (this.cfg.screenPossess !== false && now > this.nextTakeover) {
      if (this.quiet && !this.fullscreen && !reducedMotion.matches) this.possessScreen();
      else this.nextTakeover = now + 2 * MIN;
    }

    if (now > this.nextGlance) {
      this.nextGlance = now + rand(5000, 12000);
      if (this.quiet && !this.dancing) this.glance();
    }

    if (now > this.nextIdle) {
      const late = h < 5 || h >= 23;
      this.nextIdle = now + rand(20000, 50000) * (late ? 1.6 : 1);
      if (this.quiet && !this.dancing) this.idle();
      else this.nextIdle = now + 8000;
    }
  }

  // ---------- 1. the app in front ----------

  onAppSwitch(evt) {
    if (!evt) return;
    const now = performance.now();
    const same = this.front && this.front.bundleId === evt.bundleId && this.front.name === evt.name;
    const wasFull = Boolean(this.front?.fullscreen);
    this.front = evt;
    this.fullscreen = Boolean(evt.fullscreen);
    if (same) {
      if (this.fullscreen && !wasFull) this.onFullscreen();
      return;
    }
    this.mood = { kind: evt.category || 'other', until: now + 5 * MIN };
    if (this.fullscreen) {
      this.onFullscreen();
      return;
    }
    // not on every switch: one in a while, when she's free and it's quiet
    if (now - this.lastSwitch < SWITCH_GAP || Math.random() > 0.55 || !this.quiet) return;
    this.lastSwitch = now;
    this.react(evt.category || 'other');
  }

  onFullscreen() {
    const now = performance.now();
    if (now - (this.lastFullscreen || -Infinity) < 3 * MIN) return;
    this.lastFullscreen = now;
    if (this.free) this.capri.perform('look');
    this.say('fullscreen-app', {}, { line: this.quiet && Math.random() < 0.5 });
  }

  async react(kind) {
    const c = this.capri;
    const line = Math.random() < 0.45;
    const moving = c.wander && c.stance === 'stand';
    switch (kind) {
      case 'browser': // bored, or curious what you're reading
        if (Math.random() < 0.5) c.perform('bored');
        else c.perform('nosy', c.towardCenter());
        this.say('app-switch-browser', {}, { line });
        break;
      case 'code': { // interested: she comes and perches nearer
        this.say('app-switch-code', {}, { line });
        const seat = c.wander ? c.pickSeat({ frontOnly: true }) : null;
        if (seat && !(c.stance === 'sit' && c.perch?.id === seat.win.id)) await c.sitOn(seat);
        else if (moving && Math.abs(c.pos.x - c.view.w / 2) > c.view.w * 0.22) {
          const x = lerp(c.pos.x, c.view.w / 2, rand(0.45, 0.6));
          await c.teleport({ x, y: c.floor }, { face: x > c.view.w / 2 ? 1 : -1 });
        }
        await sleep(300);
        if (this.free) c.perform('curious', c.towardCenter());
        break;
      }
      case 'chat': { // nosy: leaning over to read along
        this.say('app-switch-chat', {}, { line });
        const at = await this.host.cursor().catch(() => null);
        const dir = at?.inside ? (at.x < c.pos.x ? -1 : 1) : c.towardCenter();
        if (moving && Math.random() < 0.35) {
          await c.teleport({ x: clamp(c.pos.x + dir * rand(140, 240), 150 * c.scale + 30, c.view.w - 150 * c.scale - 30), y: c.pos.y }, { face: dir < 0 ? 1 : -1 });
          await sleep(250);
        }
        if (this.free) c.perform('nosy', dir);
        break;
      }
      default:
        c.perform('look');
        this.say('app-switch', {}, { line: line && Math.random() < 0.6 });
        break;
    }
  }

  // ---------- 2. music ----------

  onMusic(msg) {
    if (!msg) return;
    if (msg.denied) {
      // macOS said no (Automation): she says so once, and her menu can turn it off
      if (this.deniedSaid) return;
      this.deniedSaid = true;
      this.panel.say({ kind: 'info', face: 'aside', line: this.lines('musicDenied'), hold: 10000 });
      return;
    }
    const playing = Boolean(msg.playing) && this.cfg.macMusic !== false;
    if (playing) this.track = msg;
    if (playing === this.music) return;
    this.music = playing;
    if (playing) this.startDance(msg);
    else this.stopDance();
  }

  startDance(msg) {
    const now = performance.now();
    const c = this.capri;
    this.dancing = true;
    this.nextSpin = now + rand(5000, 12000);
    this.nextDanceLine = now + rand(3, 6) * MIN;
    c.wake();
    this.refreshBase();
    if (this.free && c.stance === 'stand' && !reducedMotion.matches) c.perform('hop');
    this.say('music-start', { track: msg.track || msg.app || '♪' }, { line: Math.random() < 0.7 && this.quiet && Boolean(msg.track) });
  }

  stopDance() {
    const c = this.capri;
    this.dancing = false;
    this.refreshBase();
    if (this.free && c.mode === 'idle') c.perform('bored');
    this.say('music-stop', {}, { line: Math.random() < 0.4 && this.quiet });
  }

  danceTick(now) {
    const c = this.capri;
    if (c.mode === 'idle') c.lastActivity = now; // no dozing off with music on
    this.refreshBase(); // after a teleport, a fall, a sit: dancing again
    if (now > this.nextSpin) {
      this.nextSpin = now + rand(9000, 22000);
      if (this.free && c.mode === 'idle' && !reducedMotion.matches) {
        if (c.stance === 'stand') c.perform(pick(['spin', 'spin', 'spin', 'hop', 'split']), c.towardCenter());
        else c.perform('look');
      }
    }
    if (now > this.nextDanceLine) {
      this.nextDanceLine = now + rand(4, 8) * MIN;
      if (c.mode === 'idle') this.say('music-dance', {}, { line: this.quiet && Math.random() < 0.4 });
    }
  }

  // on the beat: now and then a shard of her mane flies off, or her picture jumps
  beat() {
    if (reducedMotion.matches) return;
    const r = Math.random();
    if (r < 0.3) this.capri.shed();
    else if (r < 0.38) this.capri.twitch();
  }

  // ---------- 3. the time of day ----------

  greetPeriod() {
    let seen = null;
    try {
      seen = localStorage.getItem(PERIOD_KEY);
    } catch {
      // no storage: she greets once per launch and period
    }
    const id = periodId();
    if (seen === id || this.greeted === id) return;
    if (!this.quiet) return; // later, at a quiet moment
    this.greeted = id;
    try {
      localStorage.setItem(PERIOD_KEY, id);
    } catch {
      // see above
    }
    this.greet(periodOf());
  }

  greet(period) {
    const c = this.capri;
    const act = { morning: 'stretch', afternoon: 'look', evening: 'curious', 'late-night': 'yawn' }[period];
    c.perform(act, c.towardCenter());
    this.say(period, {}, { hold: 4500 });
  }

  // ---------- 4. your computer ----------

  onPc(evt) {
    if (!evt?.key) return;
    const c = this.capri;
    const s = c.scale;
    const show = this.free && !reducedMotion.matches;
    if (!c.stowed && evt.key !== 'cpu-hot') c.wake();
    switch (evt.key) {
      case 'charger-in': // a jolt of fresh power: a hop, sparks off her hands, her specks lit up
        this.voice.play('charge');
        if (show) {
          c.perform('hop');
          const h = c.head();
          this.fx.burst(h.x, h.y + 40 * s, { count: 14, power: 0.5, spread: 90 * s });
          this.fx.crackle(() => c.limb('L').hand, { life: 520, radius: 40 * s + 12, count: 2 });
          this.fx.crackle(() => c.limb('R').hand, { life: 520, radius: 40 * s + 12, count: 2 });
          tween(c.p, { sparkle: 1.8 }, 300, ease.out).then(() => tween(c.p, { sparkle: 1 }, 700, ease.inOut));
        }
        break;
      case 'charger-out': // unplugged: a flinch and a flicker
        if (show) {
          c.twitch();
          c.perform('flinch');
        }
        break;
      case 'battery-low': // she curls up small, fading a little
        if (show) {
          c.perform('fold');
          tween(c.p, { alpha: 0.65 }, 400, ease.out).then(() => sleep(700)).then(() => tween(c.p, { alpha: 1 }, 500, ease.inOut));
        }
        break;
      case 'net-down':
        if (show) c.hurt();
        else this.voice.play('error');
        break;
      case 'net-up':
        if (show) c.perform('split');
        break;
      case 'cpu-hot': // bristling, a flicker of red
        if (show) {
          c.perform('flinch');
          c.twitch();
          const h = c.head();
          this.fx.burst(h.x, h.y - 30 * s, { count: 10, power: 0.4, spread: 80 * s });
        }
        break;
      default:
        break;
    }
    this.say(evt.key, { percent: evt.percent ?? '' }, { line: !this.panel.visible && !c.stowed, hold: 4500 });
  }

  // ---------- 5. her screen takeover ----------

  async possessScreen({ forced = false } = {}) {
    if (this.possessing) return false;
    const c = this.capri;
    this.nextTakeover = performance.now() + rand(20, 40) * MIN;
    if (forced) {
      if (c.stowed) {
        this.host.setConfig({ visible: true });
        await c.unstow();
      }
      c.wake();
      if (c.stance === 'peek') await c.unpeek();
      await this.until(() => this.free, 8000);
    }
    if (!this.free) return false;
    this.possessing = true;
    c.busy = true;
    c.wake();
    c.onTeleport?.('start');
    this.say('screen-possess', {}, { line: false });
    if (c.stance === 'sit') await c.perform('dive');
    await c.vanish();
    const { w, h } = this.fx.size || { w: innerWidth, h: innerHeight };
    await takeover({
      image: this.fx.grab,
      w,
      h,
      ms: rand(2400, 3400),
      onCue: (cue) => {
        if (cue === 'open') this.voice.play('charge');
        else if (cue === 'face') this.voice.play('bolt');
        else if (cue === 'tag') this.voice.play('possess');
        else if (cue === 'collapse') this.voice.play('teleport-out');
      },
    });
    await sleep(120);
    await c.arrive(c.spot(Math.random() < 0.5 ? 'stage' : 'random'));
    await c.settle();
    this.possessing = false;
    if (this.free) c.perform(pick(['curious', 'split']), c.towardCenter());
    return true;
  }

  // ---------- 6. more life when idle ----------

  // Her eyes on your pointer: turning to it, a cocked head at it, from further away than she notices it on her own.
  async glance() {
    const c = this.capri;
    if (c.stance !== 'stand') return;
    const at = await this.host.cursor().catch(() => null);
    if (!at?.inside || !this.quiet) return;
    const h = c.head();
    const d = Math.hypot(at.x - h.x, at.y - h.y);
    if (d < 230 || d > 900) return; // up close, notice() in capri.js does it
    const facing = at.x < c.pos.x ? 1 : -1;
    if (facing !== c.facing) c.perform('turn');
    else if (Math.random() < 0.35) c.perform('curious', at.x < h.x ? -1 : 1);
  }

  idle() {
    const c = this.capri;
    const late = new Date().getHours() < 5;
    const mood = this.mood?.kind;
    const stand = c.stance === 'stand';
    const moves = c.wander && stand;
    const win = moves ? this.peekableWindow() : null;
    const options = [
      ['stretch', 2],
      ['yawn', late ? 3 : mood === 'browser' ? 1.5 : 0.5],
      ['bored', mood === 'browser' ? 2 : 0.4],
      ['cursor', mood === 'chat' ? 2.5 : 1.5],
      ['follow', moves ? (mood === 'code' ? 2.5 : 1.8) : 0],
      ['hop', moves ? 1.6 : 0],
      ['peekWindow', win ? 1.6 : 0],
    ];
    let r = Math.random() * options.reduce((n, [, wt]) => n + wt, 0);
    const [what] = options.find(([, wt]) => (r -= wt) < 0) || options[0];
    this.doIdle(what, win);
  }

  doIdle(what, win = null) {
    const c = this.capri;
    switch (what) {
      case 'stretch':
      case 'yawn':
      case 'bored':
        return c.perform(what);
      case 'cursor':
        return this.cursorPeer();
      case 'follow':
        return this.follow();
      case 'hop':
        return this.miniTeleport();
      case 'peekWindow':
        return this.peekWindow(win || this.peekableWindow());
      default:
        return null;
    }
  }

  // looking right at your pointer, leaning toward it
  async cursorPeer() {
    const c = this.capri;
    const at = await this.host.cursor().catch(() => null);
    if (!at?.inside || !this.free) return;
    const facing = at.x < c.pos.x ? 1 : -1;
    if (facing !== c.facing && c.stance === 'stand') await c.perform('turn');
    if (this.free) c.perform(c.stance === 'stand' ? 'nosy' : 'curious', at.x < c.pos.x ? -1 : 1);
  }

  // Floating after your pointer for a few seconds, keeping a little distance, then letting it go.
  async follow() {
    const c = this.capri;
    if (!this.free || c.stance !== 'stand') return;
    this.following = true;
    const s = c.scale;
    const side = 150 * s + 30;
    const end = performance.now() + rand(4000, 7500);
    c.nextMove = Math.max(c.nextMove, performance.now() + 30000);
    let first = true;
    while (performance.now() < end) {
      if (c.busy || c.dragging || c.stowed || c.dormant || c.stance !== 'stand' || c.mode !== 'idle') break;
      const at = await this.host.cursor().catch(() => null);
      if (!at?.inside) break;
      const dir = at.x < c.pos.x ? -1 : 1;
      if (first) {
        first = false;
        c.perform('nosy', dir);
      }
      const goal = {
        x: clamp(at.x - dir * (170 * s + 90), side, c.view.w - side),
        y: clamp(at.y + SPRITE.height * s * 0.45, SPRITE.height * s + 120, c.floor),
      };
      const dx = goal.x - c.pos.x, dy = goal.y - c.pos.y;
      const dist = Math.hypot(dx, dy);
      const step = Math.min(dist, 300 * (ON_TWOS / 1000)); // 300 px/s, moved on twos
      if (dist > 1) {
        c.pos = { x: c.pos.x + (dx / dist) * step, y: c.pos.y + (dy / dist) * step };
        const facing = at.x < c.pos.x ? 1 : -1;
        if (facing !== c.facing && !c.act) c.perform('turn');
        c.place();
      }
      if (Math.random() < 0.05) c.shed();
      await sleep(ON_TWOS);
    }
    this.following = false;
  }

  // A little teleport: a hop of a few hundred pixels.
  miniTeleport() {
    const c = this.capri;
    if (!this.free || c.stance !== 'stand') return null;
    const s = c.scale;
    const side = 150 * s + 30;
    const x = clamp(c.pos.x + pick([-1, 1]) * rand(150, 340), side, c.view.w - side);
    const y = Math.random() < 0.7 ? c.pos.y : clamp(c.pos.y + rand(-180, 60), SPRITE.height * s + 120, c.floor);
    return c.teleport({ x, y }, { face: c.facing });
  }

  // A window she could peek out from behind: one of the frontmost, with room beside it.
  peekableWindow() {
    const c = this.capri;
    const s = c.scale;
    const room = 170 * s + 40;
    for (const win of (c.windows?.wins || []).slice(0, 3)) {
      if (win.id === 'taskbar' || win.max || win.w < 300 || win.h < 240 || win.y < 0) continue;
      if (win.x + win.w + room < c.view.w || win.x > room) return win;
    }
    return null;
  }

  // Peeking out from behind a window's side: she slides out from it (the part of her still
  // "behind" it cut off at its edge), leans out to look around, and ducks back in.
  async peekWindow(win) {
    const c = this.capri;
    if (!win || !this.free || c.stance !== 'stand') return;
    const s = c.scale;
    const { w } = c.view;
    const room = 170 * s + 40;
    const out = win.x + win.w + room < w && (w - win.x - win.w >= win.x || win.x <= room) ? 1 : -1;
    const edge = out > 0 ? win.x + win.w : win.x;
    const y = clamp(win.y + Math.min(win.h, 640) * rand(0.6, 0.85), SPRITE.height * s + 40, Math.min(c.floor, win.y + win.h));
    const hidden = { x: edge - out * 190 * s, y };
    const shown = { x: edge - out * 12 * s, y }; // about half of her still behind it
    // what's left of the window's edge shows, what's past it is "behind" it (a polygon, not an
    // inset: mirrored, her drawing spills out of her box)
    const clip = () => {
      const left = Math.round(c.pos.x - (SPRITE.pad + SPRITE.feet.x) * s);
      const x = Math.round(edge - left);
      const far = out > 0 ? 9999 : -9999;
      c.root.style.clipPath = `polygon(${x}px -9999px, ${far}px -9999px, ${far}px 9999px, ${x}px 9999px)`;
    };
    const slide = async (from, to) => {
      for (const k of [0.45, 0.8, 1]) {
        c.pos = { x: lerp(from.x, to.x, k), y: lerp(from.y, to.y, k) };
        clip();
        c.drawFrame();
        await sleep(ON_TWOS);
      }
    };
    this.peeking = true;
    c.busy = true;
    c.wake();
    c.onTeleport?.('start');
    try {
      if (c.p.alpha > 0) await c.vanish();
      c.pos = { ...hidden };
      c.facing = out > 0 ? -1 : 1; // looking out, away from the window
      c.setStance('stand');
      clip();
      Object.assign(c.p, { collapse: 0, dissolve: 0, glitch: 0, split: 0, alpha: 1 });
      await slide(hidden, shown);
      c.perform('nosy', out);
      // a while, unless the window moves or goes, or your pointer comes too close (she's shy)
      const until = performance.now() + rand(5000, 9000);
      const same = () => c.windows.wins.find((o) => o.id === win.id && o.x === win.x && o.y === win.y && o.w === win.w);
      while (performance.now() < until && same()) {
        const m = c.mouse;
        const h = c.head();
        if (m && Math.hypot(m.x - h.x, m.y - h.y) < 200) break;
        await sleep(120);
      }
      c.endAct(false);
      await slide(shown, hidden);
      Object.assign(c.p, { alpha: 0, collapse: 1, dissolve: 0.5 });
      c.root.style.clipPath = '';
      await c.arrive(c.spot('random'));
    } finally {
      c.root.style.clipPath = '';
      this.peeking = false;
      await c.settle();
    }
  }

  // ---------- commands: her menu, and --dev scripts ----------

  onCommand(cmd) {
    switch (cmd?.name) {
      case 'possessScreen': // her menu: "Possess the screen"
        this.possessScreen({ forced: true });
        break;
      case 'macLife': // --dev: { do: 'app' | 'music' | 'pc' | 'greet' | 'idle' | 'peekWindow' | 'dance' | 'state', ... }
        if (cmd.do === 'app') this.onAppSwitch(cmd.evt);
        else if (cmd.do === 'react') this.react(cmd.kind);
        else if (cmd.do === 'music') this.onMusic(cmd.evt);
        else if (cmd.do === 'pc') this.onPc(cmd.evt);
        else if (cmd.do === 'greet') this.greet(cmd.period || periodOf());
        else if (cmd.do === 'idle') this.doIdle(cmd.what);
        else if (cmd.do === 'peekWindow') this.peekWindow(cmd.win);
        else if (cmd.do === 'state') console.log('[mac-life]', JSON.stringify({ clip: this.capri.root.style.clipPath, root: this.capri.root.style.transform, pos: this.capri.pos, free: this.free, quiet: this.quiet, dancing: this.dancing, mood: this.mood, front: this.front, base: this.capri.base?.name, mode: this.capri.mode, stance: this.capri.stance }));
        break;
      default:
        break;
    }
  }
}
