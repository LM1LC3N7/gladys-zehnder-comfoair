// -----------------------------------------------------------------------------
// Names and messages, French and English.
// -----------------------------------------------------------------------------

export const word = (entry, language) => entry?.[language] ?? entry?.en ?? '';

/** An entry whose values are functions -> the entry of their results. */
export const fill = (entry, ...args) =>
  Object.fromEntries(
    Object.entries(entry).map(([lang, value]) => [
      lang,
      typeof value === 'function' ? value(...args) : value,
    ]),
  );

/** "2 min", "45 s". */
export const duration = (ms) =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`;

export const DEVICE_NAME = { fr: 'VMC Zehnder ComfoAir', en: 'Zehnder ComfoAir ventilation' };

export const FEATURE_NAMES = {
  speed: { fr: 'Vitesse de ventilation', en: 'Ventilation speed' },
  mode: { fr: 'Mode (auto ou manuel)', en: 'Mode (auto or manual)' },
  'operating-mode': { fr: 'Mode de fonctionnement', en: 'Operating mode' },
  'temperature-outdoor': { fr: 'Température air neuf', en: 'Outdoor air temperature' },
  'temperature-extract': { fr: 'Température air extrait', en: 'Extract air temperature' },
  'temperature-supply': { fr: 'Température air soufflé', en: 'Supply air temperature' },
  'temperature-exhaust': { fr: 'Température air rejeté', en: 'Exhaust air temperature' },
  'humidity-outdoor': { fr: 'Humidité air neuf', en: 'Outdoor air humidity' },
  'humidity-extract': { fr: 'Humidité air extrait', en: 'Extract air humidity' },
  'humidity-supply': { fr: 'Humidité air soufflé', en: 'Supply air humidity' },
  'humidity-exhaust': { fr: 'Humidité air rejeté', en: 'Exhaust air humidity' },
  'flow-supply': { fr: 'Débit soufflé (m³/h)', en: 'Supply flow (m³/h)' },
  'flow-exhaust': { fr: 'Débit extrait (m³/h)', en: 'Exhaust flow (m³/h)' },
  'bypass-open': { fr: 'Ouverture du bypass (%)', en: 'Bypass opening (%)' },
  'bypass-mode': { fr: 'Bypass', en: 'Bypass' },
  'filter-days': { fr: 'Jours avant changement du filtre', en: 'Days before the filter change' },
};

export const SPEED_LABELS = {
  0: { fr: '0 - Absent (ventilation minimale)', en: '0 - Away (minimum ventilation)' },
  1: { fr: '1 - Basse', en: '1 - Low' },
  2: { fr: '2 - Moyenne', en: '2 - Medium' },
  3: { fr: '3 - Haute', en: '3 - High' },
};

export const MODE_LABELS = {
  auto: { fr: 'Automatique', en: 'Automatic' },
  manual: { fr: 'Manuel', en: 'Manual' },
};

export const OPERATING_TEXTS = {
  auto: { fr: 'Automatique', en: 'Automatic' },
  manual_limited: { fr: 'Manuel (temporaire)', en: 'Manual (temporary)' },
  manual: { fr: 'Manuel', en: 'Manual' },
  boost: { fr: 'Boost', en: 'Boost' },
  away: { fr: 'Absent', en: 'Away' },
  unknown: { fr: (n) => `Inconnu (${n})`, en: (n) => `Unknown (${n})` },
};

export const BYPASS_TEXTS = {
  auto: { fr: 'Automatique', en: 'Automatic' },
  open: { fr: 'Ouvert (forcé)', en: 'Open (forced)' },
  closed: { fr: 'Fermé (forcé)', en: 'Closed (forced)' },
  unknown: { fr: (n) => `Inconnu (${n})`, en: (n) => `Unknown (${n})` },
};

/** Connection status of the configuration screen. */
export const T = {
  noHost: {
    fr: "Saisissez l'adresse IP du ComfoConnect LAN C.",
    en: 'Enter the IP address of the ComfoConnect LAN C.',
  },
  hostInvalid: {
    fr: "Adresse non comprise : saisissez seulement l'adresse IP (ex. 192.168.1.20).",
    en: 'Address not understood: enter the IP address only (e.g. 192.168.1.20).',
  },
  pinInvalid: {
    fr: 'PIN non compris : 4 chiffres (0000 par défaut). Aucun enregistrement tenté.',
    en: 'PIN not understood: 4 digits (0000 by default). No registration tried.',
  },
  notSaved: {
    fr: "Impossible d'écrire dans /data : sans identifiant gardé, Gladys ne s'enregistre pas sur le LAN C (chaque redémarrage prendrait une nouvelle place).",
    en: 'Cannot write to /data: without a kept identifier, Gladys does not register on the LAN C (every restart would take a new place).',
  },
  connecting: {
    fr: 'Connexion au ComfoConnect LAN C…',
    en: 'Connecting to the ComfoConnect LAN C…',
  },
  connected: {
    fr: (model) => `Connecté : ${model}.`,
    en: (model) => `Connected: ${model}.`,
  },
  unreachable: {
    fr: (reason, wait) => `LAN C injoignable (${reason}). Nouvel essai dans ${wait}.`,
    en: (reason, wait) => `LAN C unreachable (${reason}). Next try in ${wait}.`,
  },
  noBridge: {
    fr: (reason, wait) =>
      `Le LAN C ne répond pas à la découverte (${reason}). Vérifiez l'adresse. Nouvel essai dans ${wait}.`,
    en: (reason, wait) =>
      `The LAN C does not answer the discovery (${reason}). Check the address. Next try in ${wait}.`,
  },
  otherSession: {
    fr: (name, wait) =>
      `Une autre application (${name || 'sans nom'}) utilise la session du LAN C : Gladys attend et redemande dans ${wait}.`,
    en: (name, wait) =>
      `Another app (${name || 'no name'}) holds the session of the LAN C: Gladys waits and asks again in ${wait}.`,
  },
  takenOver: {
    fr: (wait) =>
      `Une autre application a pris la session du LAN C : Gladys redemande dans ${wait}.`,
    en: (wait) => `Another app took the session of the LAN C over: Gladys asks again in ${wait}.`,
  },
  noUnit: {
    fr: (wait) => `Le LAN C ne signale aucune VMC ComfoAir. Nouvel essai dans ${wait}.`,
    en: (wait) => `The LAN C reports no ComfoAir unit. Next try in ${wait}.`,
  },
  noSerial: {
    fr: (wait) => `Numéro de série de la VMC illisible. Nouvel essai dans ${wait}.`,
    en: (wait) => `Serial number of the unit not readable. Next try in ${wait}.`,
  },
  pinRefused: {
    fr: 'PIN refusé par le LAN C : enregistrement arrêté. Corrigez le PIN (0000 par défaut) ; la nouvelle configuration fait un seul nouvel essai.',
    en: 'PIN refused by the LAN C: registration stopped. Fix the PIN (0000 by default); the new configuration makes one new try.',
  },
  full: {
    fr: "Le LAN C n'a plus de place pour une nouvelle application : libérez une place (voir la documentation), puis cliquez sur « Tester la connexion ».",
    en: 'The LAN C has no room for another app: free a place (see the documentation), then click "Test the connection".',
  },
  registrationFailed: {
    fr: (why) =>
      `L'enregistrement de Gladys sur le LAN C n'a pas abouti (${why}) : il n'est jamais retenté de lui-même (le PIN serait renvoyé). Vérifiez le LAN C, puis cliquez sur « Tester la connexion » (un seul nouvel essai).`,
    en: (why) =>
      `The registration of Gladys on the LAN C did not succeed (${why}): it is never retried by itself (the PIN would be sent again). Check the LAN C, then click "Test the connection" (one new try).`,
  },
  stateUnreadable: {
    fr: "Le fichier d'état de /data (comfoair-state.json) existe mais est illisible : il n'est pas remplacé (il garde l'identifiant de Gladys sur le LAN C). Réparez-le ou supprimez-le, puis redémarrez l'intégration.",
    en: 'The state file in /data (comfoair-state.json) exists but cannot be read: it is not replaced (it keeps the identifier of Gladys on the LAN C). Repair or delete it, then restart the integration.',
  },
  unregistered: {
    fr: "Gladys n'est plus enregistrée sur le LAN C (retirée par une autre application ?). Aucun nouvel enregistrement automatique : cliquez sur « Tester la connexion » pour s'enregistrer à nouveau.",
    en: 'Gladys is no longer registered on the LAN C (removed by another app?). No automatic new registration: click "Test the connection" to register again.',
  },
};

/** Command refusals and outcomes. */
export const E = {
  readOnly: { fr: 'Cette fonctionnalité est en lecture seule.', en: 'This feature is read only.' },
  badValue: {
    fr: (v) => `Valeur refusée (${v}) : rien n'a été envoyé.`,
    en: (v) => `Value refused (${v}): nothing was sent.`,
  },
  disabled: {
    fr: "Commandes désactivées dans la configuration de l'intégration : rien n'a été envoyé.",
    en: 'Commands are disabled in the configuration of the integration: nothing was sent.',
  },
  awayDisabled: {
    fr: "La vitesse 0 (absent) coupe presque la ventilation : elle n'est pas autorisée dans la configuration. Rien n'a été envoyé.",
    en: 'Speed 0 (away) almost stops the ventilation: it is not allowed in the configuration. Nothing was sent.',
  },
  manualAtAway: {
    fr: "La vitesse est à 0 (absent) : passer en manuel la garderait, ce que la configuration n'autorise pas. Rien n'a été envoyé.",
    en: 'The speed is 0 (away): switching to manual would keep it, which the configuration does not allow. Nothing was sent.',
  },
  partial: {
    fr: (what) =>
      `${what} : partiellement appliquée (le premier message a été accepté, le second a échoué ou n'a pas été confirmé). L'état est relu.`,
    en: (what) =>
      `${what}: partly applied (the first message was accepted, the second failed or was not confirmed). The state is read again.`,
  },
  busy: {
    fr: "Une autre commande est en cours : rien n'a été envoyé.",
    en: 'Another command is running: nothing was sent.',
  },
  offline: {
    fr: "Pas de session avec le LAN C : rien n'a été envoyé.",
    en: 'No session with the LAN C: nothing was sent.',
  },
  tooLate: {
    fr: "Le LAN C n'a pas répondu à temps : rien n'a été envoyé.",
    en: 'The LAN C did not answer in time: nothing was sent.',
  },
  stateUnknown: {
    fr: "État actuel de la VMC illisible : rien n'a été envoyé.",
    en: 'Current state of the unit not readable: nothing was sent.',
  },
  refusedByUnit: {
    fr: (why) => `Envoyée, refusée par la VMC (${why}).`,
    en: (why) => `Sent, refused by the unit (${why}).`,
  },
  unconfirmed: {
    fr: (what) => `${what} : envoyée, sans confirmation de la VMC. L'état est relu.`,
    en: (what) => `${what}: sent, without confirmation from the unit. The state is read again.`,
  },
  speed: { fr: (s) => `Vitesse ${s}`, en: (s) => `Speed ${s}` },
  mode: { fr: (m) => `Mode ${m}`, en: (m) => `Mode ${m}` },
};

export const ACTION_TEXTS = {
  stillConnecting: {
    fr: 'Connexion toujours en cours, réessayez dans un instant.',
    en: 'Still connecting, try again in a moment.',
  },
  apps: {
    fr: (list) => `Applications enregistrées sur le LAN C : ${list}.`,
    en: (list) => `Apps registered on the LAN C: ${list}.`,
  },
  thisIsGladys: { fr: ' (cette intégration)', en: ' (this integration)' },
  noApps: { fr: 'Aucune application listée.', en: 'No app listed.' },
};
