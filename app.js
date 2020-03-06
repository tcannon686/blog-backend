const express = require('express');
const graphqlHttp = require('express-graphql');
const expressJwt = require('express-jwt');
const { buildSchema } = require('graphql');
const { MongoClient, ObjectId } = require('mongodb');
const Redis = require('ioredis');
const nodemailer = require('nodemailer');
const Backend = require('./backend');

/* Settings */
const mongoPort = 27017;
const graphQlPort = 4000;
const blogDb = 'blog';
const graphiql = true;

/* Set up these settings to allow sending emails. */
const enableEmailNotifications = false;
const emailServerSettings = {
  host: 'host',
  name: 'server name',
  port: 465,
  secure: true,
  auth: {
    user: 'user',
    pass: 'password',
  },
  pool: true,
};
const emailDefaultSettings = {
  from: {
    name: 'Blog Host',
    address: 'no-reply@playcannon.com',
  },
};

const backend = new Backend(
  new Redis(),
  enableEmailNotifications
    ? nodemailer.createTransport(emailServerSettings, emailDefaultSettings)
    : null,
);

/* graphQL Schema. */
const schema = buildSchema(`

  scalar Date

  """ A post that contains a pointer to the post it is a response to. """
  type Post {
    _id: ID
    user: String
    text: String
    date: Date
    responseTo: ID
  }

  """ A blog reference. """
  type Blog {
    name: String
  }

  """ A post and its comments. """
  type PostAndComments {
    _id: ID,
    user: String
    text: String
    date: Date
    comments: [PostAndComments]
  }

  """ User configuration settings. """
  input UserSettingsInput {
    email: String
  }

  """ User configuration settings. """
  type UserSettings {
    email: String
  }

  type Query {
    """ Authenticates the user with the given username and password. If
        successful, returns a JWT in string form. Otherwise returns null. """
    authenticateUser(username: String, password: String): String

    """ Returns all of the posts created by the given user. """
    getAllPosts(user: String): [Post]

    """ Returns all of the root posts created by the given user, and the
        comments on those posts. """
    getPosts(user: String): [PostAndComments]

    """ Returns a list of all the users who have accounts on the system. """
    blogs : [Blog]

    """ Returns the user settings for the current user. """
    userSettings: UserSettings
  }

  type Mutation {
    """ Creates a user if possible, otherwise returns False. """
    createUser(username: String, password: String, email: String): Boolean

    """ Updates the current user's user settings based on the input, or returns
        False if the user is not logged in. """
    updateUserSettings(settings: UserSettingsInput): Boolean

    """ Creates a post, responding to the given post if it exists. Returns null
        if the post could not be created, or if responseTo does not exist.
        Otherwise returns the created post. """
    createPost(responseTo: ID, text: String): PostAndComments

    """ Edit the post with the given ID. Returns null if the post could not be
        edited. Otherwise returns the edited post and its comments. """
    editPost(post: ID, text: String): PostAndComments

    """ Deletes the given post. Returns False if the post does not exist or if
        the user is not logged in. """
    deletePost(post: ID): Boolean
  }
`);

/* GraphQl callbacks. */
const root = {
  createUser: (args, context) => backend.createUser(
    context,
    args.username,
    args.password,
    args.email,
  ),
  authenticateUser: (args, context) => backend.authenticateUser(
    context,
    args.username,
    args.password,
  ),
  createPost: (args, context) => backend.createPost(
    context,
    args.text,
    args.responseTo ? ObjectId(args.responseTo) : null,
  ),
  editPost: (args, context) => backend.editPost(
    context,
    args.post ? ObjectId(args.post) : null,
    args.text,
  ),
  deletePost: (args, context) => backend.deletePost(
    context,
    args.post ? ObjectId(args.post) : null,
  ),
  getAllPosts: (args, context) => backend.getAllPosts(
    context,
    args.user,
  ),
  getPosts: (args, context) => backend.getPosts(
    context,
    args.user,
  ),
  blogs: (args, context) => backend.getAllBlogs(context),
  userSettings: (args, context) => backend.getUserSettings(context),
  updateUserSettings: (args, context) => backend.updateUserSettings(context, args.settings),
};

/* Create the express webserver. Of course, if this were in production we would
 * definitely want to use TLS, but just a regular express webserver will due for
 * now. Alternatively we could use a proxy server. */
const app = express();

/* Using expressJwt to parse the JWT from the user. If one is provided, its data
 * will be stored in context.user. */
app.use(expressJwt({
  secret: backend.secret,
  credentialsRequired: false,
}));

/* Use the graphQL schema we created. */
app.use('/graphql', graphqlHttp({
  schema,
  rootValue: root,
  graphiql,
}));


const mongoClient = MongoClient(
  `mongodb://localhost:${mongoPort}`,
  { useUnifiedTopology: true },
);

mongoClient.connect().then((client) => {
  backend.connectToDatabase(client.db(blogDb));
  app.listen(graphQlPort, () => {});
}).catch((err) => {
  throw err;
});

module.exports = app;
