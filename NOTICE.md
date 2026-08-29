# Notice: purpose, scope and design

This document states what this project is, what it deliberately does not do, and
why it is built the way it is. It is a statement of purpose and design, not a
legal opinion.

## What this project is

This project is an independently created program that lets a person who has
lawfully purchased *The Coffin of Andy and Leyley* run their own copy on a
platform the shipped build does not support: a web browser, on desktop, Android
and as a PWA.

The retail game is RPG Maker MV running under NW.js, which is Chromium plus
Node.js. It therefore depends on Node APIs (`require`, `process`, `zlib`,
filesystem I/O) that a browser does not provide. The purpose of this project is
to supply browser equivalents for those interfaces so that the user's own copy
of the game runs unmodified against them.

That is what this project is for: interoperability between an independently
created program and a program the user already owns, on hardware the user
already owns.

The intent is specifically to make that owned copy usable, and pleasant to use,
on the web and on mobile, which are the platforms the shipped build does not
target. Part of what this program adds is required for those platforms to be
usable at all: a phone has no keyboard, so touch and mouse input take the place
of the key handling the retail build assumes, and installation as an app is what
turns a web page into something launchable. The rest answers requests the
community has made for years: saving at any moment, save previews, save export
and backup, and access to community-made mods and translations.

These are features of this independent program and its runtime. They operate on
the user's own copy as it is played; they do not alter, repackage or
redistribute the game's content.

## What this project does not distribute

This project contains no assets, code or data from *The Coffin of Andy and
Leyley*, and ships none. Playing requires the user's own installation, which the
app never obtains on their behalf.

That is a property of how the project is built, not a policy it promises to
follow. Anyone can check each of these:

- **Nothing of the game ships with the app.** No part of it is included in this
  repository, in any published build, or on the site.
- **The copy has to come from the user.** It is supplied once, through
  `loader.html`, by picking their own installation folder or `.zip`. Until they
  do, there is no game here to run.
- **Only a genuine Steam installation is accepted.** At import the supplied
  files are checked for the Steam runtime libraries the retail build ships, and
  those libraries' hashes must match. Anything else is refused before a single
  file is stored, so a repacked or content-only copy will not run here.
- **What is imported never leaves the device.** Files are written to that
  browser's IndexedDB and are never uploaded, transmitted, proxied or shared.
  The game runs entirely in the browser, and no part of it is ever sent
  anywhere.
- **Nothing identifies anyone.** Two totals are counted: how many times each mod
  or translation has been installed, and how many times each achievement has
  been unlocked. Both are shown in the app, which is what they exist for. They
  are stored as plain running totals and nothing else, with no account, cookie,
  identifier or device information attached, so no count can be traced to the
  person who caused it. Requests are rate limited by IP address, which is used
  for that check alone and is never recorded. Beyond those two totals there is
  no analytics and no tracking of any kind.

A user who has not purchased and installed the game gets nothing from this
project. Without a copy the user already has, it does nothing at all.

## No money is made from this

This project earns nothing, from anyone, anywhere. It sells nothing, it asks
for and accepts no donations, it carries no advertising, no sponsorship and no
affiliate links, and it has no paid tier or paid feature. Nothing about it is
monetised in any form, directly or indirectly.

Running it costs nothing either. The site is static and served by GitHub Pages,
with Cloudflare in front for DNS and a small Worker that holds nothing but
public install and achievement counts. Both sit inside their free tiers. There
is no server to rent and no bill to cover, so there is no cost that would ever
need to be recouped.

The only purchase this project ever points anyone at is the game itself, on
Steam. Nothing comes back here from it: no affiliate link, no referral link, and
no revenue share of any kind.

## Community mods

The mods and translations offered in the in-game Mods menu are third-party
works. They were made and published by members of the community, and none of
them originate with this project.

Translations are collected from the thread Kit9 opened on Steam so that the
community would have somewhere to share them:

https://steamcommunity.com/app/2378900/discussions/2/594019168548841045/

Mods are collected from the game's page on Nexus Mods:

https://www.nexusmods.com/games/thecoffinofandyandleyley/mods

Because a browser cannot fetch from either source at runtime, and because the
works arrive in a variety of formats that have to be normalised before they can
be installed, they are mirrored on this project's own infrastructure rather than
retrieved from Steam or Nexus Mods directly. That mirror is a technical
requirement of running in a browser, not a claim over the works. They remain
their authors', are credited to them, and were published by them for the
community to use with the game. Any author who would rather their work not be
mirrored can write to pro@kidev.org and it will be removed.

This project ships no tooling for authoring mods, and no way to import a
user-supplied mod file. It installs only the community works in that registry.

## On the technological measures in the retail build

This part is better described plainly than talked around, so here it is in full.

The retail game stores assets under SHA-256 derived filenames and encrypts them
with a per-file rolling XOR cipher, and the embedded runtime performs a
file-read integrity check. This project reimplements the filename derivation and
the cipher in `app/sw.js` and neutralizes the integrity check in
`app/js/libs/browser-shim.js`, because none of the browser paths can function
otherwise: the service worker must resolve a canonical asset path to the file
actually on disk and decode it before a browser can render it, and the runtime
check assumes filesystem access that does not exist in a browser.

Every one of these steps is performed locally, at load time, against files the
user imported from their own installation. Nothing that results is written back,
redistributed or made available to anyone else. The decoded bytes go to the
browser's own image, audio and JSON decoders and nowhere else; they are simply
what a browser needs in order to display the game.

Nothing here reconstructs an editable copy of the game, and no tooling for doing
so is distributed. Decoding is confined to what playback requires.

## Interoperability

This project is offered on the understanding that it falls within the reverse
engineering for interoperability provisions of applicable law, in particular
**Article 6 of Directive 2009/24/EC** and **17 U.S.C. 1201(f)**. Both attach
conditions, and this project is built to meet each of them:

- **Two programs exchanging information.** The interoperability at issue is
  between the browser and the game. The browser provides rendering, audio,
  input and storage; the game provides the data and code that drive them. This
  project is the layer through which the two exchange that information and each
  act on what it receives. Without it they cannot exchange anything at all,
  which is the entire reason the shipped build does not run here.
  (**1201(f)(4)**)
- **Performed by lawful holders of a copy.** The analysis was done by a person
  who bought the game, and the program is usable only by others who did the
  same. (**Article 6(1)(a)**, **1201(f)(1)**)
- **The information was not otherwise available.** The filename derivation and
  the asset cipher are undocumented and unpublished. There is no specification,
  no API and no browser build from which they could have been obtained without
  examining the shipped program. (**Article 6(1)(b)**, **1201(f)(1)**)
- **Confined to the parts that interoperability requires.** What was examined
  and reimplemented is the platform boundary: path resolution, the asset
  cipher, and the runtime's assumption of Node APIs and filesystem access. The
  embedded runtime is patched only at that boundary, and every patch is listed
  in the open source of this repository. The game's writing, art, audio and
  gameplay were not reproduced here. (**Article 6(1)(c)**)
- **Used for no other goal.** The result is a platform layer that lets an
  unmodified copy run where it otherwise cannot. Nothing learned in the process
  is applied to any other purpose. (**Article 6(2)(a)**, **1201(f)(2)**)
- **Published only to enable interoperability.** The code is released so that
  other lawful owners can run their own copy in a browser, and for no other
  reason. (**Article 6(2)(b)**, **1201(f)(3)**)
- **Not a substitute for the game.** Nothing here is substantially similar in
  expression to the game, and nothing here can be played without it. It cannot
  displace a purchase, because it requires one. (**Article 6(2)(c)**)
- **No prejudice to normal exploitation.** The project distributes no content,
  refuses files that did not come from a genuine Steam install, earns nothing,
  and points only at the game's own store page. Its practical effect on the
  normal exploitation of the game is to require a purchase in order to use it.
  (**Article 6(3)**)

It is likewise not used to enable infringement, and it is structured so that it
cannot conveniently be turned to that purpose.

## Requirement on users

You must own a legitimate copy of the game. This project provides no way to
obtain the game and is useless without one. Please buy it:

https://store.steampowered.com/app/2378900/The_Coffin_of_Andy_and_Leyley/

## Rights holders

This is an unofficial fan project. It is not affiliated with, endorsed by, or
sponsored by Kit9 Studio, the game's owner and publisher, or by its author.

If you hold rights in the game and have any concern about this project, please
contact the maintainer directly before pursuing other channels. Requests from
rights holders will be acted on promptly and in good faith, including removal.

Contact: pro@kidev.org

## Licence

The code in this repository is licensed under AGPLv3; see LICENSE. That licence
covers this project's own code only, and grants no rights in any third-party
work, including the game.
