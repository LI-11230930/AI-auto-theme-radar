# Third-party notices

## Bundled component

`theme-radar-app/vendor/qrcode-generator/qrcode.cjs` is qrcode-generator 1.4.4 by Kazuhiko Arase, distributed under MIT. Its original license and package source/hash metadata are retained in the same directory. This component generates the local QR login image.

## Optional dependencies

Python ASR and SMTP bridge dependencies are installed separately. Requirements are listed under `theme-radar-app/bridges/`; their upstream licenses apply independently. Speech-model weights are downloaded separately and are not included in this repository. Node.js, DSH, other Agent hosts, browser and model/email service accounts are not bundled.

## Inspiration

The reading workflow was inspired by https://github.com/c1overzz/dsh-bili-scroll . This source distribution does not include that repository's bundled Python MCP implementation.
