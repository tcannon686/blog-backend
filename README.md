# Blog Backend Server
This is the backend server for the blog. You will need to have mongodb and Redis
installed. To run the server, start mongod and redis. Then, run npm start.

I ran the following to run on Ubuntu:
```
$ redis-server &
$ systemctl start mongod
$ npm start
```

To run the frontend, see the frontend git project.

## GraphiQL
This project uses GraphQL for the API. You can run an interactive 'GraphiQL'
session by browsing to http://localhost:4000/graphiql. Note that the `graphql`
setting must be set to true in app.js for this to work.
