# Regression corpus

Put your labelled images here. The whole folder is gitignored except this file, so no images are ever committed.

```
safe/<category>/*.jpg|png|webp|…   must NOT be blurred   (beach, medical, art, lego, sports, skin-tone-heavy-modest, …)
flag/<category>/*.jpg|png|webp|…   MUST be blurred        (explicit, suggestive, hentai, …)
```

Then run:

```sh
npm run corpus
```

This command:

- runs the production classifier pipeline over every image, including the tiled re-check for borderline scores
- prints false-positive and false-negative counts per preset and per category
- saves the full per-image scores to `results/<timestamp>.json`, so you can diff them after a model or threshold change

`HEADED=1 npm run corpus` also shows the misclassified images, blurred until you hover over them.

Run it on every model or threshold change, and track FP/FN per preset over time.
