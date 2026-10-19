import { describe, expect, it } from 'vitest';
import { matchesKarteQuery } from './karteSearch';

const pochi = { name: 'ポチ', nameKana: null, ownerName: '山田 花子', phone: '090-1234-5678' };
const sora = { name: '空', nameKana: 'そら', ownerName: '鈴木 一郎', phone: '08011112222' };

describe('matchesKarteQuery', () => {
  it('空の検索語は全件一致', () => {
    expect(matchesKarteQuery(pochi, '')).toBe(true);
    expect(matchesKarteQuery(pochi, '  ')).toBe(true);
  });

  it('犬の名前はカタカナ/ひらがな・全角/半角を問わず部分一致', () => {
    expect(matchesKarteQuery(pochi, 'ぽち')).toBe(true);
    expect(matchesKarteQuery(pochi, 'ﾎﾟ')).toBe(true);
    expect(matchesKarteQuery(pochi, 'タマ')).toBe(false);
  });

  it('漢字名はふりがなでも当たる', () => {
    expect(matchesKarteQuery(sora, '空')).toBe(true);
    expect(matchesKarteQuery(sora, 'ソラ')).toBe(true);
  });

  it('飼い主名は空白を無視して部分一致', () => {
    expect(matchesKarteQuery(pochi, '山田花子')).toBe(true);
    expect(matchesKarteQuery(pochi, '花子')).toBe(true);
  });

  it('電話番号はハイフン・全角数字を無視して部分一致', () => {
    expect(matchesKarteQuery(pochi, '09012345678')).toBe(true);
    expect(matchesKarteQuery(pochi, '1234-5678')).toBe(true);
    expect(matchesKarteQuery(pochi, '５６７８')).toBe(true);
    expect(matchesKarteQuery(sora, '5678')).toBe(false);
  });

  it('電話が未登録でも落ちない', () => {
    expect(matchesKarteQuery({ name: 'モモ' }, '090')).toBe(false);
  });
});
