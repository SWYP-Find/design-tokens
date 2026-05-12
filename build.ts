import StyleDictionary from 'style-dictionary';
import { config } from './style-dictionary.config.ts';

try {
  const sd = new StyleDictionary(config);
  await sd.cleanAllPlatforms();
  await sd.buildAllPlatforms();
  console.log('\n✔ Build complete: build/ios/');
} catch (err) {
  console.error('\n✖ Build failed.');
  console.error(err instanceof Error && err.stack ? err.stack : err);
  process.exit(1);
}
