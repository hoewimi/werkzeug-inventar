# Werkzeug-Inventar

Web-App fürs iPhone zum Inventarisieren von Werkzeugmaschinen: zwei Fotos je Gerät, Inventarnummer mit QR-Etikett, Typenschild auslesen per Claude, Sicherung als ZIP und Liste als CSV.

## Benutzen
In Safari https://hoewimi.github.io/werkzeug-inventar/ öffnen und über „Teilen“ > „Zum Home-Bildschirm“ ablegen. Die Daten bleiben nur auf dem eigenen Gerät.

Aktuelle Version: 5

## Lizenz und Datenschutz
Das Werkzeug-Inventar steht unter der MIT-Lizenz (`LICENSE`). Die enthaltene Bibliothek jsQR steht unter Apache 2.0, ihr Lizenztext steht in `THIRD-PARTY-NOTICES.md`.

Die Daten (Geräte, Fotos, Nummern) bleiben auf dem Gerät. Nur beim Auslesen eines Typenschilds geht das Foto mit dem eigenen API-Schlüssel an die Claude-API von Anthropic. GitHub Pages liefert die App aus und kann dabei Protokolldaten wie die IP-Adresse verarbeiten. Die App setzt keine Cookies und hat keinen Zähler.
