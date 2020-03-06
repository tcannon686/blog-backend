const jwt = require('jsonwebtoken');

const crypto = require('crypto');
const RoleError = require('./rollerror');

/**
 * Takes an array of posts with responseTos and returns a promise that
 * resolves to an array of PostAndComments.
 */
function unflatten(posts) {
  const table = {};
  const ret = [];

  // For each post.
  posts.forEach((post) => {
    let postAndComments;

    // If the post is already in the table, use that object.
    if (table[post._id]) {
      postAndComments = table[post._id];

    // Otherwise use a newly created object.
    } else {
      postAndComments = {
        comments: [],
      };
      table[post._id] = postAndComments;
    }

    // Copy the attributes from the post into the table.
    postAndComments._id = post._id;
    postAndComments.user = post.user;
    postAndComments.text = post.text;
    postAndComments.date = post.date;

    // If the post is a root post, add it to the list of posts.
    if (post.responseTo == null || !table[post.responseTo]) {
      ret.push(postAndComments);

    /**
     * If responding to a post, add this post to that post's comments. The
     * post should have been passed already.
     */
    } else if (post.responseTo) {
      // Add this post to the comments of the responseTo post.
      table[post.responseTo].comments.push(postAndComments);
    }
  });
  return ret;
}

class Backend {
  constructor(redis, mailTransporter) {
    // Initialize secret for JWT.
    this.secret = 'M6r^9?/=B^k("<Cw]tT]2!A#LuyxD9`W';

    this.redis = redis;
    this.mailTransporter = mailTransporter;
  }

  /**
   * Creates a user given the username, password, and optional email. Returns
   * null if the user already exists.
   */
  createUser(context, username, password, email) {
    if (!username || !password) return false;

    const hash = crypto.createHash('sha256');
    const key = `user:${username}`;
    const salt = crypto.randomBytes(256);
    const { redis } = this;

    return redis.type(key)
      // Return null if the user already exists.
      .then((result) => {
        if (result === 'hash') throw new Error('user already exists.');
        return redis.hmset(
          key,
          'salt',
          salt,
        );
      })
      // Otherwise store the salt and has the password.
      .then(() => {
        hash.update(
          `${key
          }:${salt
          }:${password}`,
        );
        return redis.hmset(
          key,
          'hash',
          hash.digest('hex'),
        );
      })
      // Store the user information in the database.
      .then(() => {
        const collection = this.db.collection('users');
        return collection.insertOne({
          username,
          email: email || null,
        });
      })
      // Return true if successful.
      .then(() => true)
      // Otherwise return false.
      .catch(() => false);
  }

  // Returns a list of all users.
  getAllBlogs() {
    // Only return the username aliased to name.
    return this.db.collection('users')
      .aggregate([
        {
          $project: {
            name: '$username',
            _id: 0,
          },
        },
      ]).toArray();
  }

  // Returns the current user's settings.
  getUserSettings(context) {
    return this.requireRole(context, 'user')
      .then(() => this.db.collection('users')
        .findOne({ username: context.user.loggedInAs }))
      .catch(() => null);
  }

  /**
   * Updates the current user's settings. Returns True if successful, false
   * otherwise.
   */
  updateUserSettings(context, settings) {
    const set = {};
    if (settings.email !== undefined) set.email = settings.email;

    return this.requireRole(context, 'user')
      .then(() => this.db.collection('users')
        .findOneAndUpdate(
          { username: context.user.loggedInAs },
          { $set: set },
        ))
      .then((result) => !!result.value);
  }

  // Authenticates a user and returns a JWT if successful.
  authenticateUser(context, username, password) {
    const hash = crypto.createHash('sha256');
    const key = `user:${username}`;
    const { redis } = this;
    const { secret } = this;

    if (!username || !password) return null;

    let desiredHash;

    // Return the salt and hash from redis, then check.
    return redis.type(key)
      .then((t) => {
        if (t !== 'hash') throw new Error('user does not exist.');
      })
      .then(() => redis.hmget(key, 'hash'))
      .then((result) => {
        desiredHash = result;
        return redis.hmget(key, 'salt');
      })
      .then((salt) => {
        // Hash the password.
        hash.update(`${key}:${salt}:${password}`);

        // If the hash is the same, login.
        if (hash.digest('hex').toString() === desiredHash.toString()) {
          return jwt.sign({
            loggedInAs: username,
          }, secret);
        }
        return null;
      })
      // Return null if failed.
      .catch(() => null);
  }

  getRole(context, postId) {
    const collection = this.db.collection('posts');

    // If the user is logged in they are at least a user.
    if (context.user
        && context.user.loggedInAs
        && context.user.loggedInAs.length) {
      const user = context.user.loggedInAs;

      // If the user matches the user of the post they are the owner.
      if (postId) {
        return collection.findOne({ _id: postId })
          .then((result) => {
            if (result && result.user === user) return 'owner';
            return 'user';
          });
      }
      return Promise.resolve('user');
    }
    // If the user is not logged in they are a guest.
    return Promise.resolve('guest');
  }

  /**
   * Returns a promise that if the user has the given role resolves to their
   * role, otherwise throws a RoleError.
   */
  requireRole(context, role, postId) {
    return this.getRole(context, postId)
      .then((postRole) => {
        if (postRole === role) {
          return role;
        } if (postRole === 'owner' && (role === 'user' || role === 'guest')) {
          return role;
        } if (postRole === 'user' && role === 'guest') {
          return role;
        }
        throw new RoleError(`role required: ${role}, actual role: ${postRole}`);
      });
  }

  // Returns a promise that notifies that given user.
  notifyUser(context, user, subject, message) {
    const users = this.db.collection('users');
    return users.findOne({ username: user })
      .then((settings) => {
        if (settings.email && settings.email.length) {
          // If mailing is enabled, send the user an email.
          if (this.mailTransporter) {
            const options = {
              to: settings.email,
              subject,
              text: message,
            };
            return this.mailTransporter.sendMail(options);
          } return null;
        } return null;
      });
  }

  createPost(context, text, responseTo) {
    const collection = this.db.collection('posts');

    const user = context.user.loggedInAs;
    if (!user) {
      return null;
    }

    // Return null if no text was provided.
    if (!text || !text.length) return null;

    const doc = {
      user,
      text,
      responseTo,
      date: new Date(),
    };

    // Insert the post.
    // If responseTo is provided, make sure it exists.
    if (responseTo) {
      return this.requireRole(context, 'user', responseTo)
        // Find the user who the user is replying to and notify them.
        .then(() => {
          collection.findOne({ _id: responseTo })
            .then((result) => {
              const notification = `Dear ${result.user},\n\n${user} replied to your post!\n${user} wrote:\n"${text}"\n\nThanks!`;
              // Send the notification.
              this.notifyUser(
                context,
                result.user,
                'New Reply!',
                notification,
              ).catch(() => {});
            });
        })
        .then(() => collection.insertOne(doc))
        // Return the created post if successful.
        .then((result) => ({
          _id: result.insertedId,
          user: doc.user,
          text: doc.text,
          date: doc.date,
          comments: [],
        }))
        // Otherwise return null.
        .catch(() => null);
    }

    // Otherwise just insert the post.
    return this.requireRole(context, 'user')
      .then(() => collection.insertOne(doc))
      // Return the created post if successful.
      .then((result) => ({
        _id: result.insertedId,
        user: doc.user,
        text: doc.text,
        date: doc.date,
        comments: [],
      }))
      // Otherwise return null.
      .catch(() => null);
  }

  editPost(context, postId, text) {
    const collection = this.db.collection('posts');

    // Find the post with the given ID and update it.
    return this.requireRole(context, 'owner', postId)
      .then(() => collection.findOneAndUpdate(
        { _id: postId },
        { $set: { text, date: new Date() } },
      ))
      .then((result) => {
        if (!result.value) return null;
        return this.getPost(postId);
      })
      .then((array) => unflatten(array)[0])
      .catch(() => null);
  }

  deletePost(context, post) {
    const collection = this.db.collection('posts');

    // Find the post with the given ID and delete it.
    return this.requireRole(context, 'owner', post)
      .then(() => collection.findOneAndDelete({ _id: post }))
      .then((result) => {
        if (!result.value) throw new Error('Could not delete post.');
      })
      .then(() => collection.aggregate(
        [
          { $match: { responseTo: post } },
        ],
      ).toArray())
      // Delete the commenting posts recursively.
      .then((results) => Promise.all(results.map(
        (item) => this.deletePost(context, item._id),
      )))
      .then(() => true)
      .catch(() => false);
  }

  // Returns all of the posts created by a user.
  getAllPosts(context, user) {
    const collection = this.db.collection('posts');
    return collection.aggregate(
      [
        { $match: { user } },
        { $sort: { date: -1, user: 1 } },
      ],
    ).toArray();
  }

  // Returns an array of PostAndComments for the user's blog.
  getPosts(context, user) {
    const collection = this.db.collection('posts');

    // Get all of the user's root posts.
    return collection.aggregate(
      [
        { $match: { user, responseTo: null } },
        { $sort: { date: -1, user: 1 } },
      ],
    ).toArray()
    // Get the comments for each root post.
      .then((rootPosts) => Promise.all(rootPosts.map((post) => this.getPost(post._id))))
    // Unflatten the arrays into a tree.
      .then((arrays) => [].concat(...arrays))
      .then((arrays) => unflatten(arrays));
  }

  // Returns all the comments on the given post.
  getComments(post) {
    const collection = this.db.collection('posts');
    let comments;
    // Find comments recursively.
    return collection.aggregate([
      { $match: { responseTo: post } },
      { $sort: { date: 1, user: 1 } },
    ]).toArray()
      .then((results) => {
        comments = results;
        return Promise.all(results.map((comment) => this.getComments(comment._id)));
      })
      .then((results) => comments.concat(...results));
  }

  // Returns an array of a post and all of its comments.
  getPost(post) {
    const collection = this.db.collection('posts');
    let ret;
    // Find the post.
    return collection.findOne({ _id: post })
    // Get all of the comments on the post and its comments.
      .then((result) => {
        ret = result;
        return this.getComments(result._id);
      })
    // Add the post to the beginning of the comments.
      .then((comments) => {
        comments.unshift(ret);
        return comments;
      });
  }

  // Connect to the given database.
  connectToDatabase(db) {
    this.db = db;
  }
}

module.exports = Backend;
