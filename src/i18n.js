// -----------------------------------------------------------------------------
// Texts of the integration, in English, French, German and Spanish (English
// fallback).
//
// The manifest carries its own labels; these are the texts the code writes at
// runtime: the connection status of the Configuration screen, the result of
// its button, the answers the account writes itself in a direct message
// (before Gladys knows the sender), the widget contents and toasts.
// Vocabulary of the Gladys interface ("Link my account", "Generate a link
// code", Integrations → Bluesky → Configuration; German says "du" like the
// Gladys interface, Spanish says "usted") and of the Bluesky app (app password
// / mot de passe d'application / App-Passwort / contraseña de aplicación,
// direct messages / messages privés / Direktnachrichten / mensajes directos).
// -----------------------------------------------------------------------------

import { LANGUAGES } from './config.js';

const TEXTS = {
  // --- connection status (setConnectionStatus, 200 characters) -----------------
  statusMissing: {
    en: 'Enter the handle of the Bluesky account and an app password (Settings → Privacy and security → App passwords).',
    fr: 'Saisissez l’identifiant du compte Bluesky et un mot de passe d’application (Réglages → Confidentialité et sécurité).',
    de: 'Gib das Handle des Bluesky-Kontos und ein App-Passwort ein (Einstellungen → Privatsphäre und Sicherheit).',
    es: 'Introduzca el identificador de la cuenta de Bluesky y una contraseña de aplicación (Ajustes → Privacidad y seguridad).',
  },
  statusIdentifier: {
    en: 'The identifier must be a handle (name.bsky.social) or the e-mail address of the account.',
    fr: 'L’identifiant doit être un pseudo (nom.bsky.social) ou l’adresse e-mail du compte.',
    de: 'Die Kennung muss ein Handle (name.bsky.social) oder die E-Mail-Adresse des Kontos sein.',
    es: 'El identificador debe ser un alias (nombre.bsky.social) o la dirección de correo de la cuenta.',
  },
  statusService: {
    en: 'The server must be an https:// address, e.g. https://bsky.social (leave it empty for a bsky.social account).',
    fr: 'Le serveur doit être une adresse https://, ex. https://bsky.social (laissez vide pour un compte bsky.social).',
    de: 'Der Server muss eine https://-Adresse sein, z. B. https://bsky.social (leer lassen für ein bsky.social-Konto).',
    es: 'El servidor debe ser una dirección https://, p. ej. https://bsky.social (déjelo vacío para una cuenta bsky.social).',
  },
  statusConnected: {
    en: 'Connected to Bluesky as @{handle} ({host}).',
    fr: 'Connecté à Bluesky en tant que @{handle} ({host}).',
    de: 'Mit Bluesky als @{handle} verbunden ({host}).',
    es: 'Conectado a Bluesky como @{handle} ({host}).',
  },
  statusConnectedNoDm: {
    en: 'Connected as @{handle}, but the app password does not allow direct messages: create one with “Allow access to your direct messages”.',
    fr: 'Connecté en tant que @{handle}, mais le mot de passe d’application n’autorise pas les messages privés : créez-en un avec l’accès aux messages privés.',
    de: 'Als @{handle} verbunden, aber das App-Passwort erlaubt keine Direktnachrichten: Erstelle eines mit Zugriff auf Direktnachrichten.',
    es: 'Conectado como @{handle}, pero la contraseña de aplicación no permite mensajes directos: cree una con acceso a los mensajes directos.',
  },
  statusRefused: {
    en: 'Bluesky refuses the identifier or the app password ({error}): check them, or create a new app password.',
    fr: 'Bluesky refuse l’identifiant ou le mot de passe d’application ({error}) : vérifiez-les, ou créez un nouveau mot de passe d’application.',
    de: 'Bluesky lehnt die Kennung oder das App-Passwort ab ({error}): Prüfe sie oder erstelle ein neues App-Passwort.',
    es: 'Bluesky rechaza el identificador o la contraseña de aplicación ({error}): compruébelos o cree una nueva contraseña de aplicación.',
  },
  statusTwoFactor: {
    en: 'Bluesky asks for a code sent by e-mail: enter an app password, never the main password of the account.',
    fr: 'Bluesky demande un code envoyé par e-mail : saisissez un mot de passe d’application, jamais le mot de passe principal du compte.',
    de: 'Bluesky verlangt einen per E-Mail gesendeten Code: Gib ein App-Passwort ein, nie das Hauptpasswort des Kontos.',
    es: 'Bluesky pide un código enviado por correo: introduzca una contraseña de aplicación, nunca la contraseña principal de la cuenta.',
  },
  statusAccount: {
    en: 'The Bluesky account is not active ({error}): deactivated, suspended or taken down.',
    fr: 'Le compte Bluesky n’est pas actif ({error}) : désactivé, suspendu ou retiré.',
    de: 'Das Bluesky-Konto ist nicht aktiv ({error}): deaktiviert, gesperrt oder entfernt.',
    es: 'La cuenta de Bluesky no está activa ({error}): desactivada, suspendida o retirada.',
  },
  statusRateLimited: {
    en: 'Bluesky asks to wait (too many requests): next try at {time}.',
    fr: 'Bluesky demande de patienter (trop de requêtes) : nouvel essai à {time}.',
    de: 'Bluesky bittet zu warten (zu viele Anfragen): nächster Versuch um {time}.',
    es: 'Bluesky pide esperar (demasiadas solicitudes): nuevo intento a las {time}.',
  },
  statusUnreachable: {
    en: 'Bluesky does not answer: check the internet connection of Gladys.',
    fr: 'Bluesky ne répond pas : vérifiez la connexion Internet de Gladys.',
    de: 'Bluesky antwortet nicht: Prüfe die Internetverbindung von Gladys.',
    es: 'Bluesky no responde: compruebe la conexión a Internet de Gladys.',
  },
  statusError: {
    en: 'Bluesky answered an error ({error}): see the logs of the integration.',
    fr: 'Bluesky a répondu une erreur ({error}) : voir les journaux de l’intégration.',
    de: 'Bluesky hat einen Fehler gemeldet ({error}): siehe Protokolle der Integration.',
    es: 'Bluesky respondió un error ({error}): consulte los registros de la integración.',
  },

  // --- the "Test the connection" button -----------------------------------------
  testOk: {
    en: 'Account @{handle}, {followers} followers. Direct messages: {dm}. Linked users: {linked}.',
    fr: 'Compte @{handle}, {followers} abonnés. Messages privés : {dm}. Utilisateurs liés : {linked}.',
    de: 'Konto @{handle}, {followers} Follower. Direktnachrichten: {dm}. Verknüpfte Benutzer: {linked}.',
    es: 'Cuenta @{handle}, {followers} seguidores. Mensajes directos: {dm}. Usuarios vinculados: {linked}.',
  },
  dmOk: { en: 'readable', fr: 'accessibles', de: 'lesbar', es: 'accesibles' },
  dmOff: { en: 'not read', fr: 'non lus', de: 'nicht gelesen', es: 'no leídos' },
  dmNoAccess: {
    en: 'refused by the app password',
    fr: 'refusés par le mot de passe d’application',
    de: 'vom App-Passwort abgelehnt',
    es: 'rechazados por la contraseña de aplicación',
  },
  dmUnknown: { en: 'unknown', fr: 'inconnu', de: 'unbekannt', es: 'desconocido' },

  // --- answers of the account in a direct message ----------------------------------
  replyLinked: {
    en: 'Hello {name}! Your Bluesky account is now linked to Gladys: write to me here.',
    fr: 'Bonjour {name} ! Votre compte Bluesky est maintenant lié à Gladys : écrivez-moi ici.',
    de: 'Hallo {name}! Dein Bluesky-Konto ist jetzt mit Gladys verknüpft: Schreib mir hier.',
    es: '¡Hola, {name}! Su cuenta de Bluesky ya está vinculada a Gladys: escríbame aquí.',
  },
  replyCodeRefused: {
    en: 'This link code is unknown or expired. In Gladys, open Integrations → Bluesky → Configuration, click “Generate a link code” and send me the new code within 15 minutes.',
    fr: 'Ce code de liaison est inconnu ou expiré. Dans Gladys, ouvrez Intégrations → Bluesky → Configuration, cliquez sur « Générer un code de liaison » et envoyez-moi le nouveau code dans les 15 minutes.',
    de: 'Dieser Verknüpfungscode ist unbekannt oder abgelaufen. Öffne in Gladys Integrationen → Bluesky → Konfiguration, klicke auf „Verknüpfungscode generieren“ und sende mir den neuen Code innerhalb von 15 Minuten.',
    es: 'Este código de vinculación es desconocido o ha caducado. En Gladys, abra Integraciones → Bluesky → Configuración, pulse «Generar un código de vinculación» y envíeme el nuevo código en un plazo de 15 minutos.',
  },
  replyUnavailable: {
    en: 'Gladys cannot read your message right now, please try again in a moment.',
    fr: 'Gladys ne peut pas lire votre message pour le moment, réessayez dans un instant.',
    de: 'Gladys kann deine Nachricht gerade nicht lesen, versuche es gleich noch einmal.',
    es: 'Gladys no puede leer su mensaje en este momento, inténtelo de nuevo en un instante.',
  },
  imageNotSupported: {
    en: 'Gladys sent you an image, but Bluesky direct messages cannot carry images.',
    fr: 'Gladys vous a envoyé une image, mais les messages privés Bluesky ne peuvent pas contenir d’image.',
    de: 'Gladys hat dir ein Bild gesendet, aber Bluesky-Direktnachrichten können keine Bilder enthalten.',
    es: 'Gladys le ha enviado una imagen, pero los mensajes directos de Bluesky no admiten imágenes.',
  },

  // --- widgets ----------------------------------------------------------------------
  widgetNoProfile: {
    en: 'No Bluesky account connected yet',
    fr: 'Aucun compte Bluesky connecté pour l’instant',
    de: 'Noch kein Bluesky-Konto verbunden',
    es: 'Aún no hay ninguna cuenta de Bluesky conectada',
  },
  widgetFollowers: { en: 'Followers', fr: 'Abonnés', de: 'Follower', es: 'Seguidores' },
  widgetFollows: { en: 'Following', fr: 'Abonnements', de: 'Folge ich', es: 'Siguiendo' },
  widgetPosts: { en: 'Posts', fr: 'Posts', de: 'Posts', es: 'Posts' },
  widgetUnread: { en: 'Unread', fr: 'Non lues', de: 'Ungelesen', es: 'Sin leer' },
  widgetToday: {
    en: 'Today: {received} message(s) received, {sent} sent, {posts} post(s) published.',
    fr: 'Aujourd’hui : {received} message(s) reçu(s), {sent} envoyé(s), {posts} post(s) publié(s).',
    de: 'Heute: {received} Nachricht(en) empfangen, {sent} gesendet, {posts} Post(s) veröffentlicht.',
    es: 'Hoy: {received} mensaje(s) recibido(s), {sent} enviado(s), {posts} post(s) publicado(s).',
  },
  widgetConnection: { en: 'Connection', fr: 'Connexion', de: 'Verbindung', es: 'Conexión' },
  widgetMessages: {
    en: 'Direct messages',
    fr: 'Messages privés',
    de: 'Direktnachrichten',
    es: 'Mensajes directos',
  },
  widgetNotifications: {
    en: 'Notifications',
    fr: 'Notifications',
    de: 'Mitteilungen',
    es: 'Notificaciones',
  },
  widgetWatched: { en: 'Watched', fr: 'Surveillées', de: 'Überwacht', es: 'Vigiladas' },
  widgetOff: { en: 'Off', fr: 'Désactivées', de: 'Aus', es: 'Desactivadas' },
  widgetLinked: {
    en: 'Linked users',
    fr: 'Utilisateurs liés',
    de: 'Verknüpfte Benutzer',
    es: 'Usuarios vinculados',
  },
  widgetCheck: { en: 'Check', fr: 'Vérifier', de: 'Prüfen', es: 'Comprobar' },
  widgetConnected: { en: 'Connected', fr: 'Connecté', de: 'Verbunden', es: 'Conectado' },
  widgetConnecting: { en: 'Connecting', fr: 'Connexion…', de: 'Verbinde…', es: 'Conectando' },
  widgetUnreachable: {
    en: 'Unreachable',
    fr: 'Injoignable',
    de: 'Nicht erreichbar',
    es: 'Inalcanzable',
  },
  widgetRateLimited: {
    en: 'Paused (rate limit)',
    fr: 'En pause (limite)',
    de: 'Pausiert (Limit)',
    es: 'En pausa (límite)',
  },
  widgetRefused: {
    en: 'Password refused',
    fr: 'Mot de passe refusé',
    de: 'Passwort abgelehnt',
    es: 'Contraseña rechazada',
  },
  widgetNotConfigured: {
    en: 'Not configured',
    fr: 'Non configurée',
    de: 'Nicht konfiguriert',
    es: 'No configurada',
  },
  widgetDmOn: { en: 'Read', fr: 'Lus', de: 'Gelesen', es: 'Leídos' },
  widgetDmOff: { en: 'Off', fr: 'Désactivés', de: 'Aus', es: 'Desactivados' },
  widgetDmNoAccess: {
    en: 'Not allowed',
    fr: 'Non autorisés',
    de: 'Nicht erlaubt',
    es: 'No permitidos',
  },
  widgetDmUnknown: { en: 'Checking', fr: 'Vérification', de: 'Prüfung', es: 'Comprobando' },
  badgeMention: { en: 'Mention', fr: 'Mention', de: 'Erwähnung', es: 'Mención' },
  badgeReply: { en: 'Reply', fr: 'Réponse', de: 'Antwort', es: 'Respuesta' },
  badgeQuote: { en: 'Quote', fr: 'Citation', de: 'Zitat', es: 'Cita' },
  badgeFollow: { en: 'Follower', fr: 'Abonné', de: 'Follower', es: 'Seguidor' },
  badgeLike: { en: 'Like', fr: 'J’aime', de: 'Like', es: 'Me gusta' },
  badgeRepost: { en: 'Repost', fr: 'Republication', de: 'Repost', es: 'Republicación' },
  whatFollow: {
    en: 'followed the account',
    fr: 's’est abonné au compte',
    de: 'folgt jetzt dem Konto',
    es: 'empezó a seguir la cuenta',
  },
  whatLike: {
    en: 'liked a post of the account',
    fr: 'a aimé un post du compte',
    de: 'gefällt ein Post des Kontos',
    es: 'marcó con me gusta un post de la cuenta',
  },
  whatRepost: {
    en: 'reposted a post of the account',
    fr: 'a republié un post du compte',
    de: 'hat einen Post des Kontos geteilt',
    es: 'republicó un post de la cuenta',
  },
  whatPost: {
    en: 'posted without text',
    fr: 'a publié sans texte',
    de: 'hat ohne Text gepostet',
    es: 'publicó sin texto',
  },
  widgetNotificationsOff: {
    en: 'Notifications are not read: turn on “Watch the notifications” in the configuration of the integration.',
    fr: 'Les notifications ne sont pas lues : activez « Surveiller les notifications » dans la configuration de l’intégration.',
    de: 'Mitteilungen werden nicht gelesen: Schalte „Mitteilungen überwachen“ in der Konfiguration der Integration ein.',
    es: 'Las notificaciones no se leen: active «Vigilar las notificaciones» en la configuración de la integración.',
  },
  widgetNoNotification: {
    en: 'No notification yet.',
    fr: 'Aucune notification pour l’instant.',
    de: 'Noch keine Mitteilung.',
    es: 'Aún no hay notificaciones.',
  },
  widgetReceivedToday: {
    en: 'Received today',
    fr: 'Reçus aujourd’hui',
    de: 'Heute empfangen',
    es: 'Recibidos hoy',
  },
  widgetSentToday: {
    en: 'Sent today',
    fr: 'Envoyés aujourd’hui',
    de: 'Heute gesendet',
    es: 'Enviados hoy',
  },
  widgetMessagesOff: {
    en: 'Direct messages are not read: turn on “Read the direct messages” in the configuration of the integration.',
    fr: 'Les messages privés ne sont pas lus : activez « Lire les messages privés » dans la configuration de l’intégration.',
    de: 'Direktnachrichten werden nicht gelesen: Schalte „Direktnachrichten lesen“ in der Konfiguration der Integration ein.',
    es: 'Los mensajes directos no se leen: active «Leer los mensajes directos» en la configuración de la integración.',
  },
  widgetMessagesNoAccess: {
    en: 'The app password does not allow direct messages: create a new one with “Allow access to your direct messages” checked.',
    fr: 'Le mot de passe d’application n’autorise pas les messages privés : créez-en un nouveau en cochant l’accès aux messages privés.',
    de: 'Das App-Passwort erlaubt keine Direktnachrichten: Erstelle ein neues mit aktiviertem Zugriff auf Direktnachrichten.',
    es: 'La contraseña de aplicación no permite mensajes directos: cree una nueva marcando el acceso a los mensajes directos.',
  },
  badgeLinked: { en: 'Linked', fr: 'Lié', de: 'Verknüpft', es: 'Vinculado' },
  badgeNotLinked: { en: 'Not linked', fr: 'Non lié', de: 'Nicht verknüpft', es: 'No vinculado' },
  widgetHiddenText: {
    en: 'Direct message (text hidden)',
    fr: 'Message privé (texte masqué)',
    de: 'Direktnachricht (Text verborgen)',
    es: 'Mensaje directo (texto oculto)',
  },
  widgetNoMessage: {
    en: 'No direct message since the start of the integration.',
    fr: 'Aucun message privé depuis le démarrage de l’intégration.',
    de: 'Keine Direktnachricht seit dem Start der Integration.',
    es: 'Ningún mensaje directo desde el inicio de la integración.',
  },
};

/**
 * @description A text in a language, with its {placeholders} filled.
 * @param {string} key - The text key.
 * @param {string} language - en, fr, de or es (English otherwise).
 * @param {object} [values] - The placeholder values.
 * @returns {string} The text, or the key when unknown.
 * @example
 * t('statusConnected', 'fr', { handle: 'home.bsky.social', host: 'bsky.social' });
 */
function t(key, language, values = {}) {
  const entry = TEXTS[key];
  if (!entry) {
    return key;
  }
  const template = entry[language] ?? entry.en;
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    values[name] === undefined || values[name] === null ? whole : String(values[name]),
  );
}

/**
 * @description A text in the four languages.
 * @param {string} key - The text key.
 * @param {object|Function} [values] - Placeholder values, or `(language) => values`.
 * @returns {Record<string, string>} The multi-language text.
 */
function all(key, values = {}) {
  return Object.fromEntries(
    LANGUAGES.map((language) => [
      language,
      t(key, language, typeof values === 'function' ? values(language) : values),
    ]),
  );
}

export { LANGUAGES, TEXTS, t, all };
