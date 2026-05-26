import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const files = [
  {
    path: join('node_modules', '@lobehub', 'ui', 'es', 'Image', 'components', 'usePreview.mjs'),
    replacements: [
      [
        `\t\t\trootClassName: cx(styles.preview, rootClassName),\n\t\t\tstyles: { mask: { backdropFilter: "blur(8px)" } },\n\t\t\t...rest`,
        `\t\t\t...rest,\n\t\t\tclassNames: {\n\t\t\t\t...rest.classNames,\n\t\t\t\troot: cx(styles.preview, rootClassName, rest.classNames?.root)\n\t\t\t},\n\t\t\tstyles: {\n\t\t\t\t...rest.styles,\n\t\t\t\tmask: { backdropFilter: "blur(8px)", ...rest.styles?.mask }\n\t\t\t}`,
      ],
    ],
  },
  {
    path: join('node_modules', '@lobehub', 'ui', 'es', 'Image', 'components', 'usePreviewGroup.mjs'),
    replacements: [
      [
        `\t\t\trootClassName: cx(styles.preview, rootClassName),\n\t\t\t...rest`,
        `\t\t\t...rest,\n\t\t\tclassNames: {\n\t\t\t\t...rest.classNames,\n\t\t\t\troot: cx(styles.preview, rootClassName, rest.classNames?.root)\n\t\t\t}`,
      ],
    ],
  },
];

for (const file of files) {
  const target = join(process.cwd(), file.path);
  let source = readFileSync(target, 'utf8');
  let changed = false;

  for (const [from, to] of file.replacements) {
    if (source.includes(to)) continue;
    if (!source.includes(from)) {
      throw new Error(`Patch target changed: ${file.path}`);
    }
    source = source.replace(from, to);
    changed = true;
  }

  if (changed) writeFileSync(target, source, 'utf8');
}
