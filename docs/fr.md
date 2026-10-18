# Zehnder ComfoAir Q pour Gladys

Cette intégration relie une **VMC double flux Zehnder ComfoAir Q** (Q350,
Q450, Q600) à Gladys Assistant, **en local** sur votre réseau, par le
boîtier **ComfoConnect LAN C** branché sur la VMC.

> **Jamais testée avec une vraie VMC.** Le protocole vient de la bibliothèque
> [aiocomfoconnect](https://github.com/michaelarnauts/aiocomfoconnect)
> (celle de l'intégration ComfoConnect de Home Assistant), portée en
> JavaScript et vérifiée seulement contre un LAN C simulé. Faites vos
> premiers essais en présence et signalez ce qui ne va pas.
>
> Intégration non officielle, sans lien avec Zehnder.

## Ce qu'il faut

- Une VMC ComfoAir Q avec un **ComfoConnect LAN C** relié à votre réseau,
  joignable depuis la machine de Gladys (port **56747**, en UDP pour
  demander son identifiant, en TCP pour la session).
- Une **adresse IP fixe** pour le LAN C (réglée dans votre box).
- Le **PIN** du LAN C : **0000** d'origine, sauf si vous l'avez changé.

Un ComfoConnect PRO suit sans doute le même protocole (aiocomfoconnect le
prend en charge), mais rien n'a été vérifié ici.

## Ce que vous obtenez

Un appareil « VMC » dans l'onglet Découverte, nommé d'après le modèle que
donne la VMC (par ex. « ComfoAir Q450 B R RF ST Quality »), avec :

- **Vitesse de ventilation** : 0 (absent), 1 (basse), 2 (moyenne), 3 (haute) ;
  une liste de choix, réglable si vous l'autorisez (voir plus bas).
- **Mode (auto ou manuel)** : une liste de choix, réglable si vous
  l'autorisez.
- **Mode de fonctionnement** (texte) : automatique, manuel, manuel
  temporaire, boost, absent.
- **Températures** de l'air neuf, de l'air extrait, de l'air soufflé et de
  l'air rejeté (°C).
- **Humidités** de ces quatre airs (%).
- **Débits** soufflé et extrait (m³/h ; Gladys n'a pas d'unité de débit
  d'air : l'unité est dans le nom).
- **Bypass** : son ouverture (%) et son réglage (automatique, ouvert ou
  fermé forcé).
- **Jours avant changement du filtre**.

Les valeurs arrivent quand la VMC les envoie (le LAN C pousse chaque
changement), sans interrogation périodique.

Il n'y a **aucun interrupteur** : un « éteins tout » (Google Home, Alexa, le
MCP, HomeKit, une scène sur les interrupteurs) ne peut jamais couper la
ventilation.

## Configuration

1. **Adresse IP du LAN C** (une adresse IPv4, pas un nom).
2. **PIN du LAN C** : 4 chiffres, envoyés au LAN C **à chaque tentative
   d'enregistrement** (une seule par action de votre part : premier
   démarrage, nouvelle adresse ou nouveau PIN, « Tester la connexion »
   après un arrêt). Vide : 0000. C'est un champ secret :
   gardé par Gladys dans sa base, jamais réaffiché dans l'interface, envoyé
   seulement au LAN C, jamais écrit dans les journaux, jamais copié dans
   `/data`.
3. **Autoriser le réglage de la vitesse et du mode depuis Gladys** :
   désactivé par défaut.
4. **Autoriser aussi la vitesse 0 (absent)** : désactivé par défaut (voir
   plus bas).
5. **Langue des noms** : français ou anglais.

Le bouton **Tester la connexion** se connecte tout de suite si aucune
session n'est ouverte et dit comment cela s'est passé. Il lève aussi un
arrêt (PIN refusé, LAN C plein, enregistrement retiré ou sans réponse) : un
seul nouvel essai suit.

Le bouton **Lister les applications enregistrées sur le LAN C** (session
ouverte) montre le nom et l'identifiant de chaque application enregistrée ;
celle de Gladys est marquée « (cette intégration) ».

## Enregistrement et session

- Le LAN C n'accepte qu'**un petit nombre d'applications enregistrées**
  (chaque téléphone avec l'application Zehnder, Home Assistant, Gladys…).
  Gladys s'enregistre **une seule fois**, sous le nom « Gladys », avec un
  identifiant créé au premier démarrage et gardé dans
  `/data/comfoair-state.json`. Si ce fichier ne peut pas être écrit, Gladys
  **ne s'enregistre pas** (chaque redémarrage prendrait sinon une nouvelle
  place) et l'état le dit.
- **PIN refusé** : l'enregistrement s'arrête et n'est **jamais réessayé en
  boucle**, même après un redémarrage. Corrigez le PIN et enregistrez (un
  seul nouvel essai), ou cliquez sur « Tester la connexion ».
- **LAN C plein** : arrêt de même, jusqu'à ce que vous libériez une place
  (voir ci-dessous) puis cliquiez sur « Tester la connexion ».
- **Enregistrement sans réponse claire** (code d'erreur, pas de réponse,
  connexion coupée, redémarrage pendant l'essai) : la tentative est notée
  dans `/data` avant l'envoi ; elle n'est **jamais renouvelée d'elle-même**
  (le PIN serait renvoyé). L'état donne le code ; « Tester la connexion »,
  une nouvelle adresse ou un nouveau PIN autorisent un seul nouvel essai.
- Si le fichier `/data/comfoair-state.json` existe mais est illisible, il
  n'est jamais remplacé (il garde l'identifiant de Gladys) : rien ne démarre
  et l'état le dit. Réparez-le ou supprimez-le (Gladys prendra alors une
  nouvelle place), puis redémarrez l'intégration.
- **Enregistrement retiré** (par une autre application) : Gladys ne se
  réenregistre pas d'elle-même ; « Tester la connexion » autorise un seul
  nouvel enregistrement.
- Le LAN C n'ouvre **qu'une session à la fois**. Gladys **ne prend jamais**
  la session d'une autre application : si l'application Zehnder est
  connectée, Gladys attend et redemande (1 min, 2 min, puis toutes les
  5 minutes). Si l'application Zehnder prend la session de Gladys, Gladys
  redemande 5 minutes plus tard. Pendant ce temps, les valeurs ne sont plus
  mises à jour et l'appareil est marqué injoignable.
- À l'arrêt de l'intégration, Gladys ferme sa session, pour que l'application
  Zehnder puisse la prendre tout de suite.

## Libérer une place sur le LAN C

Retirer un enregistrement demande **une application déjà enregistrée** sur
le LAN C : quand il est plein, Gladys (pas encore enregistrée) ne peut ni
lister ni retirer. Gladys elle-même ne retire aucune application dans cette
version. Les identifiants (32 caractères) servent de clé : le LAN C
reconnaît une application à son identifiant seul, sans PIN ; ne les
partagez pas.

1. **Trouver l'identifiant à retirer** : quand Gladys a une session, le
   bouton **Lister les applications enregistrées sur le LAN C** montre le nom
   et l'identifiant de chacune (celle de Gladys est marquée « (cette
   intégration) », son identifiant est aussi dans
   `/data/comfoair-state.json`).
2. **Le retirer depuis une application déjà enregistrée**, par exemple
   l'outil en ligne de commande d'aiocomfoconnect sur un ordinateur de votre
   réseau, avec l'identifiant d'une application **déjà enregistrée** (celui
   sous lequel cet ordinateur s'est enregistré un jour, ou celui de Gladys
   lu dans `/data/comfoair-state.json`) :
   `python -m aiocomfoconnect deregister <identifiant à retirer> --host <adresse du LAN C> --uuid <identifiant d'une application déjà enregistrée>`.
   L'outil **prend la session** du LAN C : l'application Zehnder ou Gladys
   est coupée pendant ce temps ; Gladys revient d'elle-même en 5 minutes au
   plus.
3. L'application Zehnder permet peut-être de retirer un appareil (non
   vérifié). Sinon, en dernier recours, une remise à zéro du LAN C (voir sa
   notice) remet le PIN à 0000 et efface probablement les enregistrements
   (non vérifié).
4. **Supprimer l'intégration de Gladys ne libère pas sa place** sur le LAN
   C : retirez son identifiant comme ci-dessus.

Tant que Gladys tient la session, l'application Zehnder vous proposera de la
prendre : acceptez, Gladys redemandera la session 5 minutes plus tard.

## Commandes et mode absent

- Régler la vitesse ou le mode est **désactivé par défaut**. Une fois
  autorisé, **tout utilisateur de Gladys, toute scène et l'application Gladys
  peuvent les changer**.
- La **vitesse 0 (« absent »)** réduit la ventilation à son **minimum** :
  elle **coupe presque** le renouvellement d'air. Laissée ainsi alors que la
  maison est occupée, l'humidité monte (condensation, moisissures) et l'air
  se charge (CO₂, odeurs, polluants). Elle demande donc **sa propre option**,
  désactivée par défaut, et n'est faite que pour une absence. Pensez à
  remettre une vitesse normale au retour (par exemple par une scène).
- « Automatique » laisse la VMC suivre son programme et ses capteurs (et
  annule une vitesse choisie à la main) ; « Manuel » garde la vitesse
  choisie. Les messages envoyés sont exactement ceux d'aiocomfoconnect ;
  leur effet précis selon le mode n'a pas été vérifié sur une vraie VMC.
- Avant chaque commande, l'intégration **relit la vitesse ou le mode sur la
  VMC** et décide sur cette lecture, jamais sur ce qu'elle a en mémoire :
  déjà à la valeur, rien n'est envoyé ; lecture impossible, rien n'est
  envoyé. Les options sont relues juste avant l'envoi : décochées pendant
  la lecture, la commande s'arrête (« rien n'a été envoyé »).
- Une commande est envoyée dans les 3,5 s qui suivent la demande, ou refusée
  avec « rien n'a été envoyé ». La réponse de la VMC est attendue jusqu'à
  4,5 s ; sans réponse, la commande est annoncée « envoyée, sans
  confirmation » et l'état est relu deux secondes plus tard : elle n'est
  jamais annoncée « non envoyée ». Une commande refusée par la VMC le dit.
- Une seule commande à la fois. Chaque commande est écrite dans les journaux
  de l'intégration.

## Connexion

- Gladys demande l'identifiant du LAN C par UDP à son adresse ; sans
  réponse, elle reprend celui appris avant.
- Après une coupure, les nouveaux essais sont espacés : 10 s, 30 s, 1 min,
  2 min, puis toutes les 5 minutes.
- Toutes les 30 s, Gladys vérifie la session (une demande de l'heure) ; sans
  réponse en 10 s, la session est coupée puis rouverte.
- Juste après l'ouverture de la session, le LAN C envoie des zéros pour
  chaque valeur : ils sont ignorés pendant 5 s, comme le fait aiocomfoconnect.

## Limites connues

- Jamais testée avec une vraie VMC (voir plus haut).
- Le protocole du LAN C circule en clair : un appareil de votre réseau peut
  lire ce qui passe. Le PIN passe sur le réseau à chaque tentative
  d'enregistrement (une par action de votre part au plus).
- L'appareil est identifié par le numéro de série de la VMC : une autre VMC
  donne un nouvel appareil.
- Pas encore pris en charge : les alarmes et erreurs de la VMC, le boost
  temporisé, le bypass et les profils de température en commande, la
  ComfoCool et la ComfoClime, la consommation électrique.

## Confidentialité

Tout reste sur votre réseau : l'intégration ne parle qu'au LAN C.

## Licence

Apache-2.0. Logique du protocole portée depuis aiocomfoconnect (Michaël
Arnauts, MIT) : voir `THIRD_PARTY_NOTICES.md`.
