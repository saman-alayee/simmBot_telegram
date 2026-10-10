import { neon } from '@neondatabase/serverless';
import pg from 'pg';

const localQueries = new Map();

function isLocalDatabase(url) {
  if (process.env.LOCAL_PG === '1') return true;
  try {
    const host = new URL(url.replace(/^postgres(ql)?:\/\//, 'http://')).hostname;
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
}

function makePgQuery(pool) {
  const tag = async (strings, ...values) => {
    let text = strings[0];
    for (let i = 0; i < values.length; i++) text += `$${i + 1}${strings[i + 1]}`;
    const result = await pool.query(text, values);
    return result.rows;
  };
  tag.query = async (text, params = []) => {
    const result = await pool.query(text, params);
    return result.rows;
  };
  return tag;
}

export function sql() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not configured');
  if (isLocalDatabase(url)) {
    if (!localQueries.has(url)) {
      localQueries.set(url, makePgQuery(new pg.Pool({
        connectionString: url,
        max: 10,
        idleTimeoutMillis: 30_000
      })));
    }
    return localQueries.get(url);
  }
  return neon(url);
}

export function ceilTo(value, unit) {
  return Math.ceil(Number(value) / Number(unit)) * Number(unit);
}

export function calcInstallment(price, cash, months, interestPercent = 5, roundToman = 50_000) {
  const balance = Math.max(0, Number(price) - Number(cash));
  const total = balance * (1 + Number(interestPercent) / 100 * Number(months));
  const unit = Number(roundToman) > 0 ? Number(roundToman) : 50_000;
  const monthly = ceilTo(total / Number(months), unit);
  return { balance, total: monthly * Number(months), monthly };
}
