プッシュ通知アイコンの差し替え方法
=====================================

通知に表示されるアイコン画像はこのフォルダに置きます:

  public/shared/assets/icon-192.png   (192x192px・通知アイコン用)
  public/shared/assets/icon-512.png   (512x512px・PWA/高解像度用)

現在はKTTAのデフォルト画像(白球＋赤点)が入っています。
独自の画像に差し替えたい場合は、上記と同じファイル名・同じ正方形サイズ(PNG)で
上書き保存してください。透過PNG推奨。

参照箇所:
  - public/viewer/sw.js                (バックグラウンド通知)
  - public/viewer/index.html (MP.notify) (ページ表示中の通知)
