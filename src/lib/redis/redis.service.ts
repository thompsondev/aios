import { Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);
  private readonly redis: Redis;

  constructor() {
    const url = process.env.REDIS_URL?.trim() ?? '';
    const maxRetriesPerRequest = Math.max(
      1,
      Number(process.env.REDIS_MAX_RETRIES_PER_REQUEST ?? 3),
    );
    const clientOpts = {
      maxRetriesPerRequest,
      /** Fail fast when disconnected instead of queueing commands (avoids long hangs + log floods). */
      enableOfflineQueue: false,
    };
    this.redis =
      url.length > 0 ? new Redis(url, clientOpts) : new Redis(clientOpts);
    this.redis.on('error', (err) => {
      this.logger.debug(`Redis: ${err.message}`);
    });
  }

  /**
   * Saves data to Redis with an optional expiration time
   * @param key - The key to store the data under
   * @param value - The value to store (will be JSON stringified)
   * @param expireInSeconds - Optional TTL in seconds
   */
  async set(key: string, value: any, expireInSeconds?: number): Promise<void> {
    try {
      if (expireInSeconds) {
        await this.redis.setex(key, expireInSeconds, JSON.stringify(value));
      } else {
        await this.redis.set(key, JSON.stringify(value));
      }
    } catch (error) {
      throw new Error(`Error saving data to Redis: ${error.message}`);
    }
  }

  /**
   * Retrieves data from Redis by key
   * @param key - The key to retrieve data for
   * @returns The parsed data or null if not found
   */
  async get(key: string): Promise<any> {
    try {
      const data = await this.redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      throw new Error(`Error getting data from Redis: ${error.message}`);
    }
  }

  /**
   * Deletes data from Redis by key
   * @param key - The key to delete
   */
  async delete(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (error) {
      throw new Error(`Error deleting data from Redis: ${error.message}`);
    }
  }

  /**
   * Retrieves all data matching a pattern from Redis
   * @param pattern - The pattern to match keys against (e.g. "user:*")
   * @returns Object containing all matched key-value pairs
   */
  async getByPattern(pattern: string): Promise<Record<string, any>> {
    try {
      const keys = await this.redis.keys(pattern);
      const result: Record<string, any> = {};
      for (const key of keys) {
        const value = await this.get(key);
        result[key] = value;
      }
      return result;
    } catch (error) {
      throw new Error(
        `Error getting data by pattern from Redis: ${error.message}`,
      );
    }
  }

  async lpush(key: string, value: string): Promise<void> {
    try {
      await this.redis.lpush(key, value);
    } catch (error) {
      throw new Error(`Error pushing into Redis list: ${error.message}`);
    }
  }

  async rpop(key: string): Promise<string | null> {
    try {
      return await this.redis.rpop(key);
    } catch (error) {
      throw new Error(`Error popping from Redis list: ${error.message}`);
    }
  }
}
