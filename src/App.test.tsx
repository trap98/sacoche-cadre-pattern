import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('App trace validation controls', () => {
  it('renders the trace validation button disabled before a closed outline exists', () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain('Valider le tracé');
    expect(markup).toMatch(/<button[^>]+disabled=""[^>]*>[\s\S]*Valider le tracé/);
  });
});
