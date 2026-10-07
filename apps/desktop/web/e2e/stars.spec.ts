import { starredOf } from '@svall/protocol';
import { expect, test } from './fixtures.js';

test('a character is starred from the side card, the tree and a drop, where it was put, and a drag reorders the starred', async ({ page, svall }) => {
  const island = await svall.api.call('island.create', { name: svall.uniq('stars'), position: { x: 0, y: 500 } });
  const [a, b, c] = await Promise.all(['sa', 'sb', 'sc'].map((name) => svall.api.call('char.create', { islandId: island.id, cwd: '/tmp', name })));
  const ours = new Set([a.id, b.id, c.id]);
  const starred = async () => starredOf(await svall.api.call('state.get', {})).map((x) => x.id).filter((id) => ours.has(id));
  const row = (id: string) => page.getByTestId(`sb-star-${id}`);
  await svall.open('map');

  await page.getByTestId(`sb-char-${a.id}`).click();
  await page.getByTestId('side-card').getByTestId('side-star').click();
  await expect.poll(starred).toEqual([a.id]);
  await expect(row(a.id)).toBeVisible();

  await page.getByTestId(`sb-char-${b.id}`).hover();
  await page.getByTestId(`sb-char-star-${b.id}`).click();
  await expect.poll(starred).toEqual([b.id, a.id]);

  const height = (await row(a.id).boundingBox())!.height;
  await page.getByTestId(`sb-char-${c.id}`).dragTo(row(a.id), { targetPosition: { x: 20, y: height - 3 } });
  await expect.poll(starred).toEqual([b.id, a.id, c.id]);

  await row(c.id).dragTo(row(b.id), { targetPosition: { x: 20, y: 3 } });
  await expect.poll(starred).toEqual([c.id, b.id, a.id]);

  // a starred row dropped on the islands is not moved there
  await row(a.id).dragTo(page.getByTestId('sb-island-home'));
  await expect(row(a.id)).toHaveCount(1);
  expect((await svall.api.call('state.get', {})).characters[a.id].islandId).toBe(island.id);

  await row(a.id).hover();
  await page.getByTestId(`sb-star-toggle-${a.id}`).click();
  await expect.poll(starred).toEqual([c.id, b.id]);
  await expect(row(a.id)).toHaveCount(0);
  await expect(page.getByTestId(`sb-char-${a.id}`)).toBeVisible();

  // folded, Starred takes a drop on its header, first
  await page.getByTestId('sb-starred-toggle').click();
  await page.getByTestId(`sb-char-${a.id}`).dragTo(page.getByTestId('sb-starred-head'));
  await expect.poll(starred).toEqual([a.id, c.id, b.id]);
});
