const ORGANIZATIONS = {
  company: [
    { domain: 'google.com', aliases: ['Google', 'Google LLC', 'Google Inc.'] },
    { domain: 'microsoft.com', aliases: ['Microsoft', 'Microsoft Corporation'] },
    { domain: 'meta.com', aliases: ['Meta', 'Meta Platforms', 'Meta Platforms Inc.'] },
    { domain: 'stripe.com', aliases: ['Stripe', 'Stripe Inc.'] }
  ],
  university: [
    { domain: 'stanford.edu', aliases: ['Stanford', 'Stanford University'] },
    { domain: 'mit.edu', aliases: ['MIT', 'Massachusetts Institute of Technology'] },
    { domain: 'uwaterloo.ca', aliases: ['University of Waterloo', 'Waterloo'] },
    { domain: 'gatech.edu', aliases: ['Georgia Tech', 'Georgia Institute of Technology'] },
    { domain: 'cmu.edu', aliases: ['Carnegie Mellon', 'Carnegie Mellon University'] }
  ]
};

const normalize = (value) => String(value || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const domains = new Map(Object.entries(ORGANIZATIONS).flatMap(([kind, entries]) =>
  entries.flatMap(({ domain, aliases }) => aliases.map((alias) => [`${kind}:${normalize(alias)}`, domain]))
));

export function organizationLogoUrl(kind, name) {
  const domain = domains.get(`${kind}:${normalize(name)}`);
  return domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64` : '';
}
